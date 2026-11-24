import type { IncomingMessage,ServerResponse } from 'node:http';
import { db } from './db.ts';
import { SpaceError } from './space.ts';
import type { User } from './model.ts';

type Body=(req:IncomingMessage,max?:number)=>Promise<Record<string,unknown>>;
type Send=(res:ServerResponse,status:number,data:unknown)=>void;
type RequestRow={id:number;user_id:number;kind:string;title:string;year:number|null;status:string;title_id:number|null};
const fail=(status:number,message:string):never=>{throw new SpaceError(status,message);};
db.exec("CREATE TABLE IF NOT EXISTS media_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('film','series')),title TEXT NOT NULL,year INTEGER,notes TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled','fulfilled')),decision TEXT NOT NULL DEFAULT '',title_id INTEGER REFERENCES titles(id) ON DELETE SET NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS media_requests_user ON media_requests(user_id,created);CREATE INDEX IF NOT EXISTS media_requests_status ON media_requests(status,created);");
function str(value:unknown,max:number,optional=false):string{
  if(typeof value!=='string'||value.length>max||(!optional&&!value.trim())||/\u0000/.test(value))return fail(400,'Invalid request field.');
  return value.trim();
}
function number(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)return fail(400,'Invalid item.');return value;}
export async function requestsApi(req:IncomingMessage,res:ServerResponse,url:URL,user:User,body:Body,send:Send):Promise<void>{
  const path=url.pathname,method=req.method,uid=user.id,admin=user.role==='admin',reply=(data:unknown,status=200)=>send(res,status,data);
  if(path==='/api/requests'){
    if(method==='GET'){
      const all=admin&&url.searchParams.get('all')==='1';
      return reply({items:db.prepare("SELECT r.*,u.username,t.title AS library_title,CASE WHEN r.title_id IS NOT NULL AND EXISTS(SELECT 1 FROM variants v WHERE v.title_id=r.title_id) THEN 1 ELSE 0 END AS available FROM media_requests r JOIN users u ON u.id=r.user_id LEFT JOIN titles t ON t.id=r.title_id WHERE (?=1 OR r.user_id=?) ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,r.created DESC LIMIT 250").all(all?1:0,uid)});
    }
    if(method==='POST'){
      const x=await body(req),kind=str(x.kind,10),title=str(x.title,150),notes=str(x.notes??'',1000,true);
      if(!['film','series'].includes(kind))return fail(400,'Choose film or series.');
      const year=x.year===null||x.year===undefined?null:number(x.year);
      if(year!==null&&(year<1880||year>2100))return fail(400,'Invalid release year.');
      if(Number(db.prepare("SELECT COUNT(*) AS n FROM media_requests WHERE user_id=? AND status IN ('pending','approved')").get(uid)?.n)>=50)return fail(409,'Active request limit reached.');
      if(db.prepare("SELECT 1 FROM media_requests WHERE user_id=? AND kind=? AND title=? COLLATE NOCASE AND year IS ? AND status IN ('pending','approved')").get(uid,kind,title,year))return fail(409,'An active request already exists.');
      const now=Date.now(),id=Number(db.prepare('INSERT INTO media_requests(user_id,kind,title,year,notes,created,updated) VALUES(?,?,?,?,?,?,?)').run(uid,kind,title,year,notes,now,now).lastInsertRowid);
      return reply({id},201);
    }
  }
  const match=/^\/api\/requests\/(\d+)(?:\/matches)?$/.exec(path);
  if(!match)return fail(404,'Unknown request endpoint.');
  const id=Number(match[1]),r=db.prepare('SELECT * FROM media_requests WHERE id=? AND (user_id=? OR ?=1)').get(id,uid,admin?1:0) as RequestRow|undefined;
  if(!r)return fail(404,'Request not found.');
  if(path.endsWith('/matches')&&method==='GET'){
    if(!admin)return fail(403,'Administrator access required.');
    const query=str(url.searchParams.get('q')||r.title,150);
    return reply({items:db.prepare("SELECT id,title,year,kind FROM titles WHERE kind=? AND instr(lower(title),lower(?))>0 AND EXISTS(SELECT 1 FROM variants v WHERE v.title_id=titles.id) ORDER BY CASE WHEN year=? THEN 0 ELSE 1 END,title COLLATE NOCASE LIMIT 40").all(r.kind,query,r.year)});
  }
  if(method==='PATCH'&&!path.endsWith('/matches')){
    const x=await body(req),status=str(x.status,15);
    const decision=str(x.decision??'',1000,true);
    let titleId:number|null=null;
    if(status==='cancelled'){
      if(r.user_id!==uid||!['pending','approved'].includes(r.status))return fail(403,'Only the requester can cancel an active request.');
    }else{
      if(!admin)return fail(403,'Administrator access required.');
      if(status==='approved'||status==='rejected'){
        if(r.status!=='pending')return fail(409,'Only pending requests can be approved or rejected.');
      }else if(status==='fulfilled'){
        if(r.status!=='approved')return fail(409,'Approve the request first.');
        titleId=number(x.titleId);
        if(!db.prepare("SELECT 1 FROM titles WHERE id=? AND kind=? AND EXISTS(SELECT 1 FROM variants v WHERE v.title_id=titles.id)").get(titleId,r.kind))return fail(400,'Choose a matching title that is available in the Library.');
      }else return fail(400,'Unknown request status.');
    }
    const result=db.prepare('UPDATE media_requests SET status=?,decision=?,title_id=?,updated=? WHERE id=? AND status=?').run(status,decision,titleId,Date.now(),id,r.status);
    if(!result.changes)return fail(409,'Request changed; refresh and try again.');
    return reply({ok:true});
  }
  fail(404,'Unknown request endpoint.');
}
