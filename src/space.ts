import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import type { User } from './model.ts';

export class SpaceError extends Error {
  status: number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
const fail=(status:number,message:string):never=>{throw new SpaceError(status,message);};
const MAX_FILE=64*1024*1024, QUOTA=256*1024*1024, CHUNK=256*1024;
db.exec('BEGIN IMMEDIATE');
try {
  db.exec(
    "CREATE TABLE IF NOT EXISTS space_events (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,starts TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '');"+
    "CREATE INDEX IF NOT EXISTS space_events_owner ON space_events(user_id,starts);"+
    "CREATE TABLE IF NOT EXISTS community_friends (sender INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,accepted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(sender,recipient),CHECK(sender<>recipient));"+
    "CREATE TABLE IF NOT EXISTS community_reviews (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),review TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(user_id,title_id));"+
    "CREATE TABLE IF NOT EXISTS space_files (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,size INTEGER NOT NULL,received INTEGER NOT NULL DEFAULT 0,modified INTEGER NOT NULL,created INTEGER NOT NULL);"+
    "CREATE INDEX IF NOT EXISTS space_files_owner ON space_files(user_id);"+
    "CREATE TABLE IF NOT EXISTS space_chunks (file_id INTEGER NOT NULL REFERENCES space_files(id) ON DELETE CASCADE,offset INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(file_id,offset));"+
    "CREATE TABLE IF NOT EXISTS space_shares (file_id INTEGER NOT NULL REFERENCES space_files(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(file_id,user_id));"
  );
  db.exec('COMMIT');
} catch(error){db.exec('ROLLBACK');throw error;}

type Input=Record<string,unknown>;
type Body=(req:IncomingMessage,max?:number)=>Promise<Input>;
type Send=(res:ServerResponse,status:number,data:unknown)=>void;
type FileRow={id:number;user_id:number;name:string;size:number;received:number;modified:number};
function str(value:unknown,max:number,optional=false):string {
  if(typeof value!=='string'||value.length>max||(!optional&&!value.trim())||/\u0000/.test(value)) return fail(400,'Invalid text field.');
  return value.trim();
}
function int(value:unknown,min=1,max=Number.MAX_SAFE_INTEGER):number {
  const n=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):NaN;
  if(!Number.isSafeInteger(n)||n<min||n>max) return fail(400,'Invalid numeric field.');
  return n;
}
function account(name:unknown,id:number):number {
  const row=db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(str(name,50)) as {id:number}|undefined;
  if(!row||row.id===id) return fail(400,'Choose another existing account.');
  return row.id;
}
function owned(id:number,user:number):FileRow {
  const row=db.prepare('SELECT * FROM space_files WHERE id=? AND user_id=?').get(id,user) as FileRow|undefined;
  if(!row) return fail(404,'File not found.');
  return row;
}
function changed(result:{changes:number|bigint}):void {if(!result.changes) fail(404,'Item not found.');}
function transaction<T>(fn:()=>T):T {
  db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
}
export async function spaceApi(req:IncomingMessage,res:ServerResponse,url:URL,user:User,body:Body,send:Send):Promise<void> {
  const path=url.pathname, method=req.method, uid=user.id;
  const reply=(data:unknown,status=200)=>send(res,status,data);
  if(path==='/api/space/events'){
    if(method==='GET') return reply({items:db.prepare('SELECT id,title,starts,notes FROM space_events WHERE user_id=? ORDER BY starts LIMIT 500').all(uid)});
    if(method==='POST'){
      const x=await body(req),title=str(x.title,120),notes=str(x.notes??'',2000,true),starts=str(x.starts,40);
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(starts)||!Number.isFinite(Date.parse(starts))) fail(400,'Choose a valid date and time.');
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM space_events WHERE user_id=?').get(uid)?.n)>=500) fail(409,'Calendar limit reached.');
      return reply({id:Number(db.prepare('INSERT INTO space_events(user_id,title,starts,notes) VALUES(?,?,?,?)').run(uid,title,starts,notes).lastInsertRowid)},201);
    }
  }
  let m=/^\/api\/space\/events\/(\d+)$/.exec(path);
  if(m&&method==='DELETE'){changed(db.prepare('DELETE FROM space_events WHERE id=? AND user_id=?').run(int(m[1]),uid));return reply({ok:true});}
  if(path==='/api/community/friends'){
    if(method==='GET')return reply({items:db.prepare('SELECT u.id,u.username,f.accepted,f.sender=? AS outgoing FROM community_friends f JOIN users u ON u.id=CASE WHEN f.sender=? THEN f.recipient ELSE f.sender END WHERE f.sender=? OR f.recipient=? ORDER BY u.username COLLATE NOCASE').all(uid,uid,uid,uid)});
    if(method==='POST'){
      const x=await body(req),other=account(x.username,uid);
      transaction(()=>{
        if(db.prepare('SELECT 1 FROM community_friends WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)').get(uid,other,other,uid))fail(409,'A friendship request already exists.');
        if(Number(db.prepare('SELECT COUNT(*) AS n FROM community_friends WHERE sender=? OR recipient=?').get(uid,uid)?.n)>=200)fail(409,'Friend limit reached.');
        db.prepare('INSERT INTO community_friends(sender,recipient) VALUES(?,?)').run(uid,other);
      });
      return reply({ok:true},201);
    }
  }
  m=/^\/api\/community\/friends\/(\d+)$/.exec(path);
  if(m){
    const other=int(m[1]);
    if(method==='PATCH'){changed(db.prepare('UPDATE community_friends SET accepted=1 WHERE sender=? AND recipient=? AND accepted=0').run(other,uid));return reply({ok:true});}
    if(method==='DELETE'){changed(db.prepare('DELETE FROM community_friends WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)').run(uid,other,other,uid));return reply({ok:true});}
  }
  if(path==='/api/community/reviews'){
    if(method==='GET')return reply({items:db.prepare('SELECT r.title_id,r.rating,r.review,r.updated,u.username,r.user_id=? AS own,t.title FROM community_reviews r JOIN users u ON u.id=r.user_id JOIN titles t ON t.id=r.title_id WHERE r.user_id=? OR EXISTS(SELECT 1 FROM community_friends f WHERE f.accepted=1 AND ((f.sender=? AND f.recipient=r.user_id) OR (f.recipient=? AND f.sender=r.user_id))) ORDER BY r.updated DESC LIMIT 100').all(uid,uid,uid,uid)});
    if(method==='POST'){
      const x=await body(req),title=int(x.titleId),rating=int(x.rating,1,5),review=str(x.review??'',2000,true);
      if(!db.prepare("SELECT 1 FROM titles WHERE id=? AND kind IN ('film','series','game','music')").get(title))fail(404,'Media not found.');
      db.prepare('INSERT INTO community_reviews(user_id,title_id,rating,review,updated) VALUES(?,?,?,?,?) ON CONFLICT(user_id,title_id) DO UPDATE SET rating=excluded.rating,review=excluded.review,updated=excluded.updated').run(uid,title,rating,review,Date.now());
      return reply({ok:true});
    }
  }
  m=/^\/api\/community\/reviews\/(\d+)$/.exec(path);
  if(m&&method==='DELETE'){changed(db.prepare('DELETE FROM community_reviews WHERE user_id=? AND title_id=?').run(uid,int(m[1])));return reply({ok:true});}
  if(path==='/api/community/titles'&&method==='GET'){
    const q=str(url.searchParams.get('q')??'',80);
    return reply({items:db.prepare("SELECT id,title,year,kind FROM titles WHERE kind IN ('film','series','game','music') AND instr(lower(title),lower(?))>0 ORDER BY title COLLATE NOCASE LIMIT 40").all(q)});
  }
  if(path==='/api/space/files'){
    if(method==='GET')return reply({items:db.prepare('SELECT f.id,f.name,f.size,f.received,f.modified,f.user_id=? AS own,u.username AS owner FROM space_files f JOIN users u ON u.id=f.user_id WHERE f.user_id=? OR (f.received=f.size AND EXISTS(SELECT 1 FROM space_shares s WHERE s.file_id=f.id AND s.user_id=?)) ORDER BY f.created DESC LIMIT 300').all(uid,uid,uid),shares:db.prepare('SELECT s.file_id,u.id,u.username FROM space_shares s JOIN users u ON u.id=s.user_id JOIN space_files f ON f.id=s.file_id WHERE f.user_id=?').all(uid)});
    if(method==='POST'){
      const x=await body(req),name=str(x.name,180),size=int(x.size,0,MAX_FILE),modified=int(x.modified,0);
      if(/[\/\\\r\n\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')fail(400,'Invalid filename.');
      return reply(transaction(()=>{
        const old=db.prepare('SELECT id,received FROM space_files WHERE user_id=? AND name=? AND size=? AND modified=? AND received<size ORDER BY id DESC LIMIT 1').get(uid,name,size,modified);
        if(old)return old;
        const totals=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM space_files WHERE user_id=?').get(uid);
        if(Number(totals?.n)>=200||Number(totals?.bytes)+size>QUOTA)fail(409,'Personal file storage quota reached.');
        return {id:Number(db.prepare('INSERT INTO space_files(user_id,name,size,modified,created) VALUES(?,?,?,?,?)').run(uid,name,size,modified,Date.now()).lastInsertRowid),received:0};
      }),201);
    }
  }
  m=/^\/api\/space\/files\/(\d+)(?:\/(chunk|download|share)(?:\/(\d+))?)?$/.exec(path);
  if(m){
    const id=int(m[1]),action=m[2];
    if(action==='download'&&method==='GET'){
      const file=db.prepare('SELECT * FROM space_files f WHERE f.id=? AND f.received=f.size AND (f.user_id=? OR EXISTS(SELECT 1 FROM space_shares s WHERE s.file_id=f.id AND s.user_id=?))').get(id,uid,uid) as FileRow|undefined;
      if(!file)return fail(404,'File not found.');
      const filename=encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+filename,'Content-Length':file.size,'Cache-Control':'no-store'});
      const read=db.prepare('SELECT data FROM space_chunks WHERE file_id=? AND offset=?');
      async function* chunks(){let offset=0;while(offset<file!.size){const row=read.get(id,offset) as {data:Uint8Array}|undefined;if(!row||!row.data.length)throw new Error('Missing file chunk');offset+=row.data.length;yield row.data;}}
      await pipeline(Readable.from(chunks()),res);return;
    }
    const file=owned(id,uid);
    if(!action&&method==='DELETE'){changed(db.prepare('DELETE FROM space_files WHERE id=? AND user_id=?').run(id,uid));return reply({ok:true});}
    if(action==='chunk'&&method==='POST'){
      const x=await body(req,400000),offset=int(x.offset,0,MAX_FILE),encoded=str(x.data,350000);
      if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail(400,'Invalid file chunk.');
      const data=Buffer.from(encoded,'base64');
      if(!data.length||data.length>CHUNK||data.toString('base64')!==encoded)fail(400,'Invalid file chunk.');
      return reply(transaction(()=>{
        const current=owned(id,uid);
        if(offset!==current.received||offset+data.length>current.size)fail(409,'Upload offset changed. Select the same file to resume.');
        db.prepare('INSERT INTO space_chunks(file_id,offset,data) VALUES(?,?,?)').run(id,offset,data);
        db.prepare('UPDATE space_files SET received=? WHERE id=?').run(offset+data.length,id);
        return {received:offset+data.length};
      }));
    }
    if(action==='share'&&method==='POST'){
      if(file.received!==file.size)fail(409,'Finish uploading before sharing.');
      const x=await body(req),other=account(x.username,uid);
      if(!db.prepare('SELECT 1 FROM community_friends WHERE accepted=1 AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))').get(uid,other,other,uid))fail(403,'Only accepted friends can receive shared files.');
      db.prepare('INSERT OR IGNORE INTO space_shares(file_id,user_id) VALUES(?,?)').run(id,other);
      return reply({ok:true});
    }
    if(action==='share'&&m[3]&&method==='DELETE'){changed(db.prepare('DELETE FROM space_shares WHERE file_id=? AND user_id=?').run(id,int(m[3])));return reply({ok:true});}
  }
  fail(404,'Endpoint not found.');
}
