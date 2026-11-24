import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { SpaceError } from './space.ts';
import type { User } from './model.ts';

type Input=Record<string,unknown>;
type Body=(req:IncomingMessage,max?:number)=>Promise<Input>;
type Send=(res:ServerResponse,status:number,data:unknown)=>void;
type Worker={id:number;name:string;capabilities:string;last_seen:number};
type Job={id:number;user_id:number;worker_id:number;kind:string;payload:string;status:string;lease:string;file_id:number|null};
const kinds=['download','convert','image','video'];
const fail=(status:number,message:string):never=>{throw new SpaceError(status,message);};
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
const token=()=>randomBytes(32).toString('hex');
const MAX=64*1024*1024, CHUNK=256*1024;
// Idle worker heartbeats are ephemeral: they must not dirty SQLite/WAL pages.
const onlineWorkers=new Map<number,number>();
const workerProgress=new Map<number,{phase:string;done:number;total:number|null;updated:number}>();
db.exec(
  "CREATE TABLE IF NOT EXISTS paired_workers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,capabilities TEXT NOT NULL DEFAULT '[]',last_seen INTEGER NOT NULL DEFAULT 0);"+
  "CREATE TABLE IF NOT EXISTS worker_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,worker_id INTEGER NOT NULL REFERENCES paired_workers(id),kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',lease TEXT NOT NULL DEFAULT '',message TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,updated INTEGER NOT NULL,file_id INTEGER REFERENCES space_files(id) ON DELETE SET NULL);"+
  "CREATE INDEX IF NOT EXISTS worker_jobs_queue ON worker_jobs(worker_id,status,id);"+
  "CREATE INDEX IF NOT EXISTS worker_jobs_owner ON worker_jobs(user_id,created);"
);
function str(value:unknown,max:number):string {
  if(typeof value!=='string'||!value.trim()||value.length>max||/\u0000/.test(value))return fail(400,'Invalid input.');
  return value.trim();
}
function int(value:unknown,min=1,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return fail(400,'Invalid number.');
  return value;
}
function name(value:unknown):string {
  const s=str(value,180);if(/[\/\\\x00-\x1f\x7f]/.test(s)||s==='.'||s==='..')return fail(400,'Choose a plain filename.');return s;
}
function tx<T>(fn:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function admin(user:User){if(user.role!=='admin')fail(403,'Administrator access required.');}
function worker(req:IncomingMessage):Worker {
  const auth=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');
  if(!auth)return fail(401,'Worker authentication required.');
  const row=db.prepare('SELECT id,name,capabilities,last_seen FROM paired_workers WHERE token_hash=?').get(digest(auth[1])) as Worker|undefined;
  if(!row)return fail(401,'Worker authentication failed.');return row;
}
function active(wid:number,id:number,lease:unknown):Job {
  const row=db.prepare("SELECT * FROM worker_jobs WHERE id=? AND worker_id=? AND status='running' AND lease=?").get(id,wid,str(lease,64)) as Job|undefined;
  if(!row)return fail(409,'This job lease is no longer active.');return row;
}
function expireJobs(){
  const cutoff=Date.now()-120000;
  const expired=db.prepare("SELECT * FROM worker_jobs WHERE status='running' AND worker_id IN (SELECT id FROM paired_workers WHERE last_seen<?)").all(cutoff) as unknown as Job[];
  if(!expired.length)return;
  tx(()=>{
    for(const job of expired){workerProgress.delete(job.id);cleanupFile(job);db.prepare("UPDATE worker_jobs SET status='failed',message='Worker disconnected before reporting completion.',lease='',updated=? WHERE id=?").run(Date.now(),job.id);}
  });
}
function cleanupFile(j:Job){if(j.file_id!==null)db.prepare('DELETE FROM space_files WHERE id=? AND user_id=? AND received<size').run(j.file_id,j.user_id);}
export async function workerApi(req:IncomingMessage,res:ServerResponse,url:URL,body:Body,send:Send):Promise<void>{
  const w=worker(req),path=url.pathname,reply=(x:unknown)=>send(res,200,x);
  if(req.method!=='POST')return fail(405,'Worker requests must be POST.');
  const x=await body(req,400000);
  onlineWorkers.set(w.id,Date.now());
  if(Date.now()-w.last_seen>=30000&&db.prepare("SELECT 1 FROM worker_jobs WHERE worker_id=? AND status='running' LIMIT 1").get(w.id)){
    expireJobs();
    if(db.prepare("SELECT 1 FROM worker_jobs WHERE worker_id=? AND status='running' LIMIT 1").get(w.id))db.prepare('UPDATE paired_workers SET last_seen=? WHERE id=?').run(Date.now(),w.id);
  }
  if(path==='/api/worker/heartbeat'){
    if(!Array.isArray(x.capabilities)||x.capabilities.some(k=>typeof k!=='string'||!kinds.includes(k)))return fail(400,'Invalid worker capabilities.');
    const caps=JSON.stringify([...new Set(x.capabilities)]);if(caps!==w.capabilities)db.prepare('UPDATE paired_workers SET capabilities=? WHERE id=?').run(caps,w.id);
    return reply({ok:true});
  }
  if(path==='/api/worker/claim'){
    if(!db.prepare("SELECT 1 FROM worker_jobs WHERE worker_id=? AND status='queued' LIMIT 1").get(w.id))return reply({job:null});
    return reply(tx(()=>{
      if(db.prepare("SELECT id FROM worker_jobs WHERE worker_id=? AND status='running'").get(w.id))return {job:null};
      const caps=JSON.parse(w.capabilities) as string[];
      const jobs=db.prepare("SELECT * FROM worker_jobs WHERE worker_id=? AND status='queued' ORDER BY id LIMIT 100").all(w.id) as unknown as Job[];
      const j=jobs.find(j=>caps.includes(j.kind));if(!j)return {job:null};
      const lease=token();
      db.prepare('UPDATE paired_workers SET last_seen=? WHERE id=?').run(Date.now(),w.id);
      workerProgress.set(j.id,{phase:'Processing',done:0,total:null,updated:Date.now()});
      db.prepare("UPDATE worker_jobs SET status='running',lease=?,message='Worker processing job',updated=? WHERE id=?").run(lease,Date.now(),j.id);
      return {job:{id:j.id,kind:j.kind,payload:JSON.parse(j.payload),lease}};
    }));
  }
  const match=/^\/api\/worker\/jobs\/(\d+)\/(result|begin-file|chunk|progress)$/.exec(path);
  if(!match)return fail(404,'Unknown worker endpoint.');
  const id=Number(match[1]),action=match[2],job=active(w.id,id,x.lease);
  if(action==='progress'){
    const phase=str(x.phase,80),done=int(x.done,0),total=x.total===null?null:int(x.total,0);
    if(total!==null&&done>total)return fail(400,'Invalid progress.');
    workerProgress.set(id,{phase,done,total,updated:Date.now()});return reply({ok:true});
  }
  if(action==='begin-file'){
    const filename=name(x.name),size=int(x.size,0,MAX);
    return reply(tx(()=>{
      const current=active(w.id,id,x.lease);
      if(current.file_id!==null){
        const f=db.prepare('SELECT id,name,size,received FROM space_files WHERE id=?').get(current.file_id);
        if(f&&f.name===filename&&Number(f.size)===size)return {received:Number(f.received)};
        fail(409,'A different output file is already attached.');
      }
      const totals=db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM space_files WHERE user_id=?').get(job.user_id);
      if(Number(totals?.n)>=200||Number(totals?.bytes)+size>256*1024*1024)fail(409,'Personal file storage quota reached.');
      const file=Number(db.prepare('INSERT INTO space_files(user_id,name,size,modified,created) VALUES(?,?,?,?,?)').run(job.user_id,filename,size,Date.now(),Date.now()).lastInsertRowid);
      db.prepare('UPDATE worker_jobs SET file_id=? WHERE id=?').run(file,id);
      return {received:0};
    }));
  }
  if(action==='chunk'){
    const offset=int(x.offset,0,MAX),encoded=str(x.data,350000),data=Buffer.from(encoded,'base64');
    if(!data.length||data.length>CHUNK||data.toString('base64')!==encoded)return fail(400,'Invalid output chunk.');
    return reply(tx(()=>{
      const j=active(w.id,id,x.lease);
      const f=db.prepare('SELECT id,size,received FROM space_files WHERE id=? AND user_id=?').get(j.file_id,j.user_id);
      if(!f||Number(f.received)!==offset||offset+data.length>Number(f.size))fail(409,'Output offset changed.');
      db.prepare('INSERT INTO space_chunks(file_id,offset,data) VALUES(?,?,?)').run(j.file_id,offset,data);
      db.prepare('UPDATE space_files SET received=? WHERE id=?').run(offset+data.length,j.file_id);
      return {received:offset+data.length};
    }));
  }
  if(typeof x.ok!=='boolean')return fail(400,'Result status required.');
  const message=str(x.message,500);
  return reply(tx(()=>{
    const j=active(w.id,id,x.lease);
    if(j.file_id!==null){
      const f=db.prepare('SELECT size,received FROM space_files WHERE id=?').get(j.file_id);
      if(!f||Number(f.received)!==Number(f.size)){if(x.ok)fail(409,'Output transfer incomplete.');cleanupFile(j);}
    }
    db.prepare('UPDATE worker_jobs SET status=?,message=?,lease=?,updated=? WHERE id=?').run(x.ok?'completed':'failed',message,'',Date.now(),id);
    workerProgress.delete(id);
    return {ok:true};
  }));
}
export async function jobsApi(req:IncomingMessage,res:ServerResponse,url:URL,user:User,body:Body,send:Send):Promise<void>{
  const path=url.pathname,method=req.method,reply=(x:unknown,status=200)=>send(res,status,x);
  if(path==='/api/jobs/agent'&&method==='GET'){
    admin(user);
    const source=await readFile(new URL('./worker-agent.ts',import.meta.url));
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="hearthwave-worker.ts"','Cache-Control':'no-store'});res.end(source);return;
  }
  if(path==='/api/jobs/workers'){
    if(method==='GET'){
      expireJobs();
      const rows=db.prepare("SELECT id,name,capabilities,last_seen FROM paired_workers WHERE name NOT LIKE '% (revoked)' ORDER BY name").all() as unknown as Worker[];
      return reply({items:rows.map(w=>({id:w.id,name:w.name,capabilities:JSON.parse(w.capabilities),online:Date.now()-(onlineWorkers.get(w.id)??0)<120000}))});
    }
    if(method==='POST'){
      admin(user);const x=await body(req),label=str(x.name,80),secret=token();
      if(label.endsWith(' (revoked)'))fail(400,'Choose a different worker name.');
      if(Number(db.prepare("SELECT COUNT(*) AS n FROM paired_workers WHERE name NOT LIKE '% (revoked)'").get()?.n)>=20)fail(409,'Worker limit reached.');
      const id=Number(db.prepare('INSERT INTO paired_workers(name,token_hash) VALUES(?,?)').run(label,digest(secret)).lastInsertRowid);
      return reply({id,token:secret},201);
    }
  }
  let m=/^\/api\/jobs\/workers\/(\d+)$/.exec(path);
  if(m&&method==='DELETE'){
    admin(user);const id=Number(m[1]);
    if(db.prepare("SELECT 1 FROM worker_jobs WHERE worker_id=? AND status IN ('queued','running')").get(id))fail(409,'Cancel queued jobs and wait for running jobs before revoking this worker.');
    onlineWorkers.delete(id);
    // Keep job history intact; revoke the credential and clear capabilities.
    db.prepare("UPDATE paired_workers SET token_hash=?,capabilities='[]',last_seen=0,name=name||' (revoked)' WHERE id=? AND capabilities<>'[\"revoked\"]' AND name NOT LIKE '% (revoked)'").run(digest(token()),id);
    return reply({ok:true});
  }
  if(path==='/api/jobs'){
    if(method==='GET'){
      expireJobs();
      const all=user.role==='admin'&&url.searchParams.get('all')==='1';
      const rows=db.prepare("SELECT j.id,j.kind,j.status,j.message,j.created,j.updated,j.file_id,w.name AS worker,u.username,f.size AS output_size,f.received AS output_received,CASE WHEN j.user_id=? THEN 1 ELSE 0 END AS own FROM worker_jobs j JOIN paired_workers w ON w.id=j.worker_id JOIN users u ON u.id=j.user_id LEFT JOIN space_files f ON f.id=j.file_id WHERE (?=1 OR j.user_id=?) ORDER BY j.id DESC LIMIT 200").all(user.id,all?1:0,user.id);
      return reply({items:rows.map(row=>({...row,progress:row.status==='running'?workerProgress.get(Number(row.id))||null:null}))});
    }
    if(method==='POST'){
      const x=await body(req),kind=str(x.kind,16),wid=int(x.workerId);
      if(!kinds.includes(kind))fail(400,'Unsupported job type.');
      admin(user);
      const w=db.prepare('SELECT id,name,capabilities,last_seen FROM paired_workers WHERE id=?').get(wid) as Worker|undefined;
      if(!w||!(JSON.parse(w.capabilities) as string[]).includes(kind))fail(400,'Choose a worker that supports this job.');
      let payload:Input;
      if(kind==='download'){
        const input=str(x.url,2048);let target:URL;
        try{target=new URL(input);}catch{return fail(400,'Invalid download URL.');}
        if(!['http:','https:'].includes(target.protocol)||target.username||target.password)fail(400,'Use a plain HTTP(S) download URL.');
        payload={url:target.href,name:name(x.name)};
      }else if(kind==='convert'){
        const format=str(x.format,8);if(!['mp4','webm','mp3','flac'].includes(format))fail(400,'Unknown output format.');
        payload={name:name(x.name),format};
      }else payload={prompt:str(x.prompt,4000)};
      if(Number(db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE user_id=? AND status IN ('queued','running')").get(user.id)?.n)>=20)fail(409,'Your active job limit has been reached.');
      const now=Date.now();
      const id=Number(db.prepare('INSERT INTO worker_jobs(user_id,worker_id,kind,payload,created,updated) VALUES(?,?,?,?,?,?)').run(user.id,wid,kind,JSON.stringify(payload),now,now).lastInsertRowid);
      return reply({id},201);
    }
  }
  m=/^\/api\/jobs\/(\d+)$/.exec(path);
  if(m&&method==='DELETE'){
    const id=Number(m[1]),job=db.prepare('SELECT * FROM worker_jobs WHERE id=? AND (user_id=? OR ?=1)').get(id,user.id,user.role==='admin'?1:0) as Job|undefined;
    if(!job)return fail(404,'Job not found.');
    if(job.status==='running')fail(409,'A running job cannot be removed while its worker owns the lease.');
    tx(()=>{cleanupFile(job);db.prepare('DELETE FROM worker_jobs WHERE id=?').run(id);});return reply({ok:true});
  }
  fail(404,'Endpoint not found.');
}
