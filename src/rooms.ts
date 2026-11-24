import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { SpaceError } from './space.ts';
import type { User } from './model.ts';

type Input=Record<string,unknown>;
type Body=(req:IncomingMessage,max?:number)=>Promise<Input>;
type Send=(res:ServerResponse,status:number,data:unknown)=>void;
type Room={id:number;owner:number;title_id:number;position:number;playing:number;updated:number;title:string;host:string;revision:number};
const fail=(status:number,message:string):never=>{throw new SpaceError(status,message);};
db.exec(
  "CREATE TABLE IF NOT EXISTS watch_rooms(id INTEGER PRIMARY KEY AUTOINCREMENT,owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,position REAL NOT NULL DEFAULT 0,playing INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0);"+
  "CREATE TABLE IF NOT EXISTS watch_members(room_id INTEGER NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(room_id,user_id));"+
  "CREATE INDEX IF NOT EXISTS watch_members_user ON watch_members(user_id,room_id);"+
  "CREATE TABLE IF NOT EXISTS watch_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id INTEGER NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,message TEXT NOT NULL,created INTEGER NOT NULL);"+
  "CREATE INDEX IF NOT EXISTS watch_messages_room ON watch_messages(room_id,id);"
);
function str(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max||/\u0000/.test(value))return fail(400,'Invalid text.');return value.trim();}
function id(value:unknown):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)return fail(400,'Invalid item.');return n;}
function tx<T>(fn:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function member(room:number,uid:number):Room{
  const r=db.prepare('SELECT r.*,t.title,u.username AS host FROM watch_rooms r JOIN titles t ON t.id=r.title_id JOIN users u ON u.id=r.owner JOIN watch_members m ON m.room_id=r.id WHERE r.id=? AND m.user_id=?').get(room,uid) as Room|undefined;
  if(!r)return fail(404,'Watch room is no longer available.');return r;
}
function friend(uid:number,other:number):boolean{return !!db.prepare('SELECT 1 FROM community_friends WHERE accepted=1 AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))').get(uid,other,other,uid);}
function snapshot(r:Room,uid:number){
  const elapsed=Math.max(0,Math.min(10,(Date.now()-r.updated)/1000));
  const online=Date.now()-r.updated<10000;
  return {id:r.id,titleId:r.title_id,title:r.title,host:r.host,own:r.owner===uid,position:r.position+(r.playing?elapsed:0),playing:!!r.playing&&online,revision:r.revision,hostOnline:online};
}
export async function roomsApi(req:IncomingMessage,res:ServerResponse,url:URL,user:User,body:Body,send:Send):Promise<void>{
  const uid=user.id,path=url.pathname,method=req.method,reply=(data:unknown,status=200)=>send(res,status,data);
  if(path==='/api/community/rooms/titles'&&method==='GET'){
    const q=str(url.searchParams.get('q'),80);
    return reply({items:db.prepare("SELECT id,title,year,season,episode FROM titles WHERE kind IN ('film','episode') AND instr(lower(title),lower(?))>0 AND EXISTS(SELECT 1 FROM variants v WHERE v.title_id=titles.id) ORDER BY title COLLATE NOCASE,season,episode LIMIT 40").all(q)});
  }
  if(path==='/api/community/rooms'){
    if(method==='GET')return reply({items:db.prepare('SELECT r.id,r.title_id,r.owner,t.title,u.username AS host, r.owner=? AS own FROM watch_rooms r JOIN watch_members m ON m.room_id=r.id JOIN titles t ON t.id=r.title_id JOIN users u ON u.id=r.owner WHERE m.user_id=? ORDER BY r.id DESC LIMIT 100').all(uid,uid)});
    if(method==='POST'){
      const x=await body(req),title=id(x.titleId),other=id(x.friendId);
      if(!friend(uid,other))return fail(403,'Invite an accepted friend.');
      if(!db.prepare("SELECT 1 FROM titles WHERE id=? AND kind IN ('film','episode') AND EXISTS(SELECT 1 FROM variants v WHERE v.title_id=titles.id)").get(title))return fail(404,'Choose an available film or episode.');
      if(Number(db.prepare('SELECT COUNT(*) AS n FROM watch_rooms WHERE owner=?').get(uid)?.n)>=20)return fail(409,'Close an existing watch room before creating another.');
      const room=tx(()=>{
        const room=Number(db.prepare('INSERT INTO watch_rooms(owner,title_id,updated) VALUES(?,?,?)').run(uid,title,Date.now()).lastInsertRowid);
        const add=db.prepare('INSERT INTO watch_members(room_id,user_id) VALUES(?,?)');
        add.run(room,uid);add.run(room,other);return room;
      });
      return reply({id:room},201);
    }
  }
  const match=/^\/api\/community\/rooms\/(\d+)(?:\/(sync|chat|invite))?$/.exec(path);
  if(!match)return fail(404,'Unknown watch room endpoint.');
  const room=id(match[1]),action=match[2],r=member(room,uid);
  if(!action&&method==='GET'){
    const messages=db.prepare('SELECT * FROM (SELECT m.id,m.message,m.created,u.username FROM watch_messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 50) ORDER BY id').all(room);
    const members=db.prepare('SELECT u.id,u.username FROM watch_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY u.username').all(room);
    return reply({room:snapshot(r,uid),messages,members});
  }
  if(!action&&method==='DELETE'){
    if(r.owner===uid)db.prepare('DELETE FROM watch_rooms WHERE id=?').run(room);
    else db.prepare('DELETE FROM watch_members WHERE room_id=? AND user_id=?').run(room,uid);
    return reply({ok:true});
  }
  if(action==='sync'&&method==='POST'){
    if(r.owner!==uid)return fail(403,'Only the host controls playback.');
    const x=await body(req);
    if(typeof x.position!=='number'||!Number.isFinite(x.position)||x.position<0||x.position>604800||typeof x.playing!=='boolean')return fail(400,'Invalid playback state.');
    db.prepare('UPDATE watch_rooms SET position=?,playing=?,updated=?,revision=revision+1 WHERE id=? AND owner=?').run(x.position,x.playing?1:0,Date.now(),room,uid);
    return reply({ok:true});
  }
  if(action==='invite'&&method==='POST'){
    if(r.owner!==uid)return fail(403,'Only the host can invite members.');
    const x=await body(req),other=id(x.friendId);
    if(!friend(uid,other))return fail(403,'Invite an accepted friend.');
    if(Number(db.prepare('SELECT COUNT(*) AS n FROM watch_members WHERE room_id=?').get(room)?.n)>=20)return fail(409,'Watch room member limit reached.');
    db.prepare('INSERT OR IGNORE INTO watch_members(room_id,user_id) VALUES(?,?)').run(room,other);return reply({ok:true});
  }
  if(action==='chat'&&method==='POST'){
    const x=await body(req),message=str(x.message,1000),now=Date.now();
    tx(()=>{
      if(db.prepare('SELECT 1 FROM watch_messages WHERE room_id=? AND user_id=? AND created>? LIMIT 1').get(room,uid,now-750))fail(429,'Please wait before sending another message.');
      db.prepare('INSERT INTO watch_messages(room_id,user_id,message,created) VALUES(?,?,?,?)').run(room,uid,message,now);
      db.prepare('DELETE FROM watch_messages WHERE room_id=? AND id NOT IN (SELECT id FROM watch_messages WHERE room_id=? ORDER BY id DESC LIMIT 200)').run(room,room);
    });
    return reply({ok:true},201);
  }
  fail(404,'Unknown watch room endpoint.');
}
