import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { backup, DatabaseSync } from 'node:sqlite';
import { readUpdateStatus, writeInstalledUpdate, writeUpdateStatus } from './update-state.ts';

interface Config {
  root:string;dataDir:string;stage:string;sha:string;version:string;oldPid:number;port:number;host:string;
}
interface Swap {name:string;oldMoved:boolean;newMoved:boolean}

function alive(pid:number):boolean {
  try {process.kill(pid,0);return true;}
  catch(error) {return (error as NodeJS.ErrnoException).code==='EPERM';}
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForExit(pid:number,timeoutMs:number):Promise<boolean> {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until) {if(!alive(pid)) return true;await delay(200);}
  return !alive(pid);
}
function validate(config:Config):void {
  if(!isAbsolute(config.root) || !isAbsolute(config.dataDir) || !isAbsolute(config.stage) ||
    !/^\.[Hh]earthwave-update-[\w-]+$/.test(config.stage.split('/').at(-1)||'') ||
    relative(config.root,config.stage).startsWith('..') ||
    !/^[a-f0-9]{40}$/.test(config.sha) || !/^\d+\.\d+\.\d+$/.test(config.version) ||
    !Number.isSafeInteger(config.oldPid) || config.oldPid<1 ||
    !Number.isSafeInteger(config.port) || config.port<1 || config.port>65535)
    throw new Error('Unsafe updater handoff configuration.');
}

async function snapshotDatabase(config:Config):Promise<string> {
  const databasePath=join(config.dataDir,'hearthwave.sqlite');
  const size=(await stat(databasePath)).size;
  const free=await statfs(config.stage);
  if(free.bavail*free.bsize<size+16*1024*1024) throw new Error('Not enough free disk space for a reversible database migration.');
  const snapshot=join(config.stage,'rollback.sqlite');
  const sqlite=new DatabaseSync(databasePath,{enableForeignKeyConstraints:true});
  try {await backup(sqlite,snapshot);}
  finally {sqlite.close();}
  return snapshot;
}

async function restoreDatabase(config:Config,snapshot:string):Promise<void> {
  const databasePath=join(config.dataDir,'hearthwave.sqlite');
  const temporary=join(config.dataDir,'.hearthwave-rollback-restore.sqlite');
  await copyFile(snapshot,temporary);
  await rm(databasePath+'-wal',{force:true});
  await rm(databasePath+'-shm',{force:true});
  await rename(temporary,databasePath);
}

async function swapCode(config:Config,swaps:Swap[]):Promise<void> {
  const previous=join(config.stage,'previous');
  await mkdir(previous,{recursive:true});
  for(const name of ['src','web','package.json','README.md']) {
    const entry:Swap={name,oldMoved:false,newMoved:false};
    swaps.push(entry);
    const current=join(config.root,name);
    const replacement=join(config.stage,'source',name);
    try {await rename(current,join(previous,name));entry.oldMoved=true;}
    catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT' || name!=='README.md') throw error;}
    await rename(replacement,current);
    entry.newMoved=true;
  }
}

async function restoreCode(config:Config,swaps:Swap[]):Promise<void> {
  const failed=join(config.stage,'failed');
  await mkdir(failed,{recursive:true});
  for(const item of [...swaps].reverse()) {
    if(item.newMoved) await rename(join(config.root,item.name),join(failed,item.name));
    if(item.oldMoved) await rename(join(config.stage,'previous',item.name),join(config.root,item.name));
  }
}

async function launch(config:Config):Promise<ChildProcess> {
  const log=join(config.dataDir,'hearthwave-server.log');
  const fd=openSync(log,'w',0o600);
  try {
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types','src/server.ts'],
      {cwd:config.root,detached:true,stdio:['ignore',fd,fd],env:process.env});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    return child;
  } finally {closeSync(fd);}
}

async function healthy(config:Config,child:ChildProcess,requirePid=true):Promise<boolean> {
  const host=['0.0.0.0','::','[::]'].includes(config.host)?'127.0.0.1':config.host;
  const address=`http://${host.includes(':')?`[${host}]`:host}:${config.port}/api/health`;
  const until=Date.now()+25000;
  while(Date.now()<until) {
    if(child.exitCode!==null) return false;
    try {
      const response=await fetch(address,{signal:AbortSignal.timeout(1500),cache:'no-store'});
      if(response.ok) {
        const health=await response.json() as {ok?:boolean;version?:string;pid?:number};
        if(health.ok && health.version===config.version && (!requirePid || health.pid===child.pid)) return true;
      }
    } catch { /* The new listener has not started yet. */ }
    await delay(350);
  }
  return false;
}

async function stopChild(child:ChildProcess):Promise<void> {
  if(!child.pid || child.exitCode!==null) return;
  try {process.kill(child.pid,'SIGTERM');} catch {}
  if(!await waitForExit(child.pid,5000)) {
    try {process.kill(child.pid,'SIGKILL');} catch {}
    await waitForExit(child.pid,3000);
  }
}

async function run(config:Config):Promise<void> {
  const swaps:Swap[]=[];
  let snapshot:string|undefined;
  let launched:ChildProcess|undefined;
  let oldStopped=false;
  try {
    if(!await waitForExit(config.oldPid,30000)) throw new Error('The original server did not stop. No code was replaced.');
    oldStopped=true;
    await writeUpdateStatus(config.dataDir,'installing','Preserving the database and activating the verified application files.',config.sha,config.version);
    snapshot=await snapshotDatabase(config);
    await swapCode(config,swaps);
    await writeUpdateStatus(config.dataDir,'health-check','Starting the updated server and checking its health.',config.sha,config.version);
    launched=await launch(config);
    if(!await healthy(config,launched)) throw new Error('The updated server did not become healthy.');
    await writeInstalledUpdate(config.dataDir,config.sha,config.version);
    await writeUpdateStatus(config.dataDir,'complete',`Hearthwave ${config.version} is installed and running.`,config.sha,config.version);
  } catch(error) {
    const reason=error instanceof Error?error.message:'Unknown update failure.';
    if(oldStopped) {
      await writeUpdateStatus(config.dataDir,'rolling-back','Update failed; restoring the previous application and database.',config.sha,config.version).catch(()=>{});
      if(launched) await stopChild(launched);
      try {
        if(swaps.length) await restoreCode(config,swaps);
        if(snapshot) await restoreDatabase(config,snapshot);
        const restored=await launch(config);
        if(!await healthyOld(config,restored)) throw new Error('The previous server could not restart.');
        await writeUpdateStatus(config.dataDir,'failed',`Update rolled back: ${reason}`,config.sha,config.version);
      } catch(restoreError) {
        await writeUpdateStatus(config.dataDir,'failed',`Update failed: ${reason}. Recovery also failed: ${String(restoreError)}. Inspect the installation directory.`,config.sha,config.version).catch(()=>{});
        throw restoreError;
      }
    } else {
      await writeUpdateStatus(config.dataDir,'failed',reason,config.sha,config.version).catch(()=>{});
    }
  } finally {
    await rm(config.stage,{recursive:true,force:true}).catch(()=>{});
  }
}

async function healthyOld(config:Config,child:ChildProcess):Promise<boolean> {
  const oldVersion=JSON.parse(await readFile(join(config.root,'package.json'),'utf8')) as {version:string};
  return healthy({...config,version:oldVersion.version},child,false);
}

const configPath=process.argv[2];
if(!configPath) throw new Error('The updater worker requires a prepared handoff file.');
const config=JSON.parse(await readFile(configPath,'utf8')) as Config;
validate(config);
const status=await readUpdateStatus(config.dataDir);
if(status.sha!==config.sha || !['verifying','restarting'].includes(status.phase)) throw new Error('This updater handoff is no longer valid.');
await run(config);
