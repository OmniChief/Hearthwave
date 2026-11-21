import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type UpdatePhase='idle'|'downloading'|'verifying'|'restarting'|'installing'|'health-check'|'rolling-back'|'complete'|'failed';
export interface UpdateStatus {
  phase:UpdatePhase;
  message:string;
  sha?:string;
  version?:string;
  updatedAt:string;
}
export interface InstalledUpdate {sha:string;version:string;installedAt:string}

const statusFile='.hearthwave-update-status.json';
const installedFile='.hearthwave-installed.json';

async function readJson<T>(file:string):Promise<T|undefined> {
  try { return JSON.parse(await readFile(file,'utf8')) as T; }
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return undefined;throw error;}
}
async function saveJson(file:string,value:unknown):Promise<void> {
  const temporary=`${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
    await rename(temporary,file);
  } catch(error) {
    const {rm}=await import('node:fs/promises');
    await rm(temporary,{force:true}).catch(()=>{});
    throw error;
  }
}
export async function readUpdateStatus(dataDir:string):Promise<UpdateStatus> {
  return await readJson<UpdateStatus>(join(dataDir,statusFile)) || {phase:'idle',message:'No update has been started.',updatedAt:new Date().toISOString()};
}
export function writeUpdateStatus(dataDir:string,phase:UpdatePhase,message:string,sha?:string,version?:string):Promise<void> {
  return saveJson(join(dataDir,statusFile),{phase,message,sha,version,updatedAt:new Date().toISOString()} satisfies UpdateStatus);
}
export function readInstalledUpdate(dataDir:string):Promise<InstalledUpdate|undefined> {
  return readJson<InstalledUpdate>(join(dataDir,installedFile));
}
export function writeInstalledUpdate(dataDir:string,sha:string,version:string):Promise<void> {
  return saveJson(join(dataDir,installedFile),{sha,version,installedAt:new Date().toISOString()} satisfies InstalledUpdate);
}
