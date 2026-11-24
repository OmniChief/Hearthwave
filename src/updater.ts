import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { backupBusy } from './backup.ts';
import { dataDir } from './db.ts';
import { extractVerifiedArchive, managedFile, type ExpectedFile } from './update-archive.ts';
import { readInstalledUpdate, readUpdateStatus, writeUpdateStatus } from './update-state.ts';
import { describeStartupFailure } from './update-diagnostics.ts';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const apiRoot='https://api.github.com/repos/OmniChief/Hearthwave';
const headers={'Accept':'application/vnd.github+json','User-Agent':'Hearthwave-updater','X-GitHub-Api-Version':'2022-11-28'};
const running=new Set(['downloading','verifying','restarting','installing','health-check','rolling-back']);
const execute=promisify(execFile);
let installing=false;
let checkedAt=0;
let latestCache:RemoteCommit|undefined;

export class UpdateError extends Error {
  status:number;
  constructor(status:number,message:string) {super(message);this.status=status;}
}
interface RemoteCommit {sha:string;treeSha:string;version:string}

async function githubJson(url:string):Promise<Record<string,unknown>> {
  let response:Response;
  try {response=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});}
  catch {throw new UpdateError(502,'GitHub is not reachable. Check the NAS internet connection.');}
  if(!response.ok) {
    if(response.status===403 || response.status===429) throw new UpdateError(503,'GitHub is rate-limiting update checks. Try again later.');
    throw new UpdateError(502,`GitHub returned HTTP ${response.status}.`);
  }
  try {
    if(!response.body) throw new Error('Empty response');
    const chunks:Buffer[]=[];
    let bytes=0;
    for await(const chunk of response.body) {
      const buffer=Buffer.from(chunk);
      bytes+=buffer.length;
      if(bytes>2*1024*1024) throw new UpdateError(413,'GitHub update metadata exceeds the safety limit.');
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
  } catch(error) {
    if(error instanceof UpdateError) throw error;
    throw new UpdateError(502,'GitHub returned invalid update metadata.');
  }
}

function validSha(value:unknown):value is string {return typeof value==='string' && /^[a-f0-9]{40}$/.test(value);}
function parseVersion(value:unknown):number[] {
  if(typeof value!=='string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new UpdateError(502,'GitHub has an invalid application version.');
  return value.split('.').map(Number);
}
function compareVersions(a:string,b:string):number {
  const left=parseVersion(a),right=parseVersion(b);
  for(let i=0;i<3;i++) if(left[i]!==right[i]) return left[i]-right[i];
  return 0;
}

async function currentVersion():Promise<string> {
  const value=JSON.parse(await readFile(join(root,'package.json'),'utf8')) as {version?:string};
  parseVersion(value.version);
  return value.version!;
}

async function remoteCommit(force=false):Promise<RemoteCommit> {
  if(!force && latestCache && Date.now()-checkedAt<60000) return latestCache;
  const commit=await githubJson(`${apiRoot}/commits/main`);
  const sha=commit.sha;
  const tree=(commit.commit as {tree?:{sha?:unknown}}|undefined)?.tree?.sha;
  if(!validSha(sha) || !validSha(tree)) throw new UpdateError(502,'GitHub did not return a valid commit.');
  const packageResponse=await githubJson(`${apiRoot}/contents/package.json?ref=${sha}`);
  if(packageResponse.encoding!=='base64' || typeof packageResponse.content!=='string') throw new UpdateError(502,'GitHub did not return the application manifest.');
  let packageData:{name?:string;version?:string};
  try {packageData=JSON.parse(Buffer.from(packageResponse.content.replace(/\s/g,''),'base64').toString('utf8')) as typeof packageData;}
  catch {throw new UpdateError(502,'The public repository package manifest is invalid.');}
  if(packageData.name!=='hearthwave') throw new UpdateError(502,'GitHub returned a different application.');
  parseVersion(packageData.version);
  latestCache={sha,treeSha:tree,version:packageData.version!};
  checkedAt=Date.now();
  return latestCache;
}

async function gitCheckoutSha():Promise<string|undefined> {
  try {
    const head=(await readFile(join(root,'.git','HEAD'),'utf8')).trim();
    if(validSha(head)) return head;
    if(!head.startsWith('ref: ')) return undefined;
    const ref=head.slice(5);
    if(!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) return undefined;
    const sha=(await readFile(join(root,'.git',ref),'utf8')).trim();
    return validSha(sha)?sha:undefined;
  } catch {return undefined;}
}

export async function checkForUpdate(force=false):Promise<{currentVersion:string;currentSha:string|null;latestVersion:string;latestSha:string;available:boolean;source:string;message:string}> {
  const [remote,version,installed]=await Promise.all([remoteCommit(force),currentVersion(),readInstalledUpdate(dataDir)]);
  const currentSha=installed?.version===version && validSha(installed.sha)?installed.sha:await gitCheckoutSha();
  const older=compareVersions(remote.version,version)<0;
  const available=!older && remote.sha!==currentSha;
  return {currentVersion:version,currentSha:currentSha||null,latestVersion:remote.version,latestSha:remote.sha,
    available,source:'OmniChief/Hearthwave · main',
    message:older?'The repository version is older than the installed version. Downgrading is blocked.'
      :available?currentSha?'A newer GitHub commit is available.':'Installed commit is unknown; you can sync to the latest public build.'
      :'This installation matches the latest GitHub commit.'};
}

export async function updateStatus():Promise<{phase:string;message:string;sha?:string;version?:string;updatedAt:string;busy:boolean}> {
  const status=await readUpdateStatus(dataDir);
  if(status.phase==='failed'&&status.message.includes('did not become healthy')){
    const log=await readFile(join(dataDir,'hearthwave-update-failed.log'),'utf8').catch(()=>'');
    const cause=describeStartupFailure(log.slice(-32000));
    if(cause&&!status.message.includes(cause))status.message+=' '+cause;
  }
  return {...status,busy:installing || (running.has(status.phase) && Date.now()-Date.parse(status.updatedAt)<30*60*1000)};
}

async function expectedTree(treeSha:string):Promise<ExpectedFile[]> {
  const result=await githubJson(`${apiRoot}/git/trees/${treeSha}?recursive=1`);
  if(result.truncated===true || !Array.isArray(result.tree)) throw new UpdateError(502,'GitHub returned an incomplete source tree.');
  const files:ExpectedFile[]=[];
  for(const entry of result.tree) {
    if(!entry || typeof entry!=='object') continue;
    const item=entry as {path?:unknown;type?:unknown;mode?:unknown;sha?:unknown;size?:unknown};
    if(item.type==='tree' && item.mode==='040000') continue;
    if(typeof item.path!=='string' || !managedFile(item.path)) continue;
    if(item.type!=='blob' || !['100644','100755'].includes(String(item.mode)) || !validSha(item.sha) ||
      !Number.isSafeInteger(item.size) || (item.size as number)<0 || (item.size as number)>16*1024*1024)
      throw new UpdateError(502,'The repository contains an unsupported update file.');
    files.push({path:item.path,sha:item.sha,size:item.size as number});
  }
  if(files.length<10 || files.length>300 || files.reduce((sum,file)=>sum+file.size,0)>64*1024*1024)
    throw new UpdateError(502,'The repository source tree exceeds the updater limits.');
  return files;
}

async function downloadArchive(sha:string,destination:string):Promise<void> {
  let response:Response;
  try {response=await fetch(`https://codeload.github.com/OmniChief/Hearthwave/tar.gz/${sha}`,{signal:AbortSignal.timeout(60000)});}
  catch {throw new UpdateError(502,'The source archive download could not start.');}
  if(!response.ok || !response.body) throw new UpdateError(502,`GitHub archive download failed (HTTP ${response.status}).`);
  let size=0;
  const limiter=new Transform({transform(chunk:Buffer,_encoding,callback) {
    size+=chunk.length;
    callback(size>24*1024*1024?new UpdateError(413,'The update archive is too large.'):null,chunk);
  }});
  try {await pipeline(Readable.fromWeb(response.body as never),limiter,createWriteStream(destination,{flags:'wx',mode:0o600}));}
  catch(error) {throw error instanceof UpdateError?error:new UpdateError(502,'The source archive download failed.');}
}

export async function startUpdate(sha:string,onRestart:()=>void,onFailure:()=>void=()=>{}):Promise<void> {
  if(installing) throw new UpdateError(409,'An update is already being prepared.');
  if(process.execArgv.some(arg=>arg==='--watch' || arg.startsWith('--watch='))) throw new UpdateError(409,'Stop watch mode and start Hearthwave normally before updating.');
  if(backupBusy()) throw new UpdateError(409,'Wait for the current database export to finish.');
  const previous=await updateStatus();
  if(previous.busy) throw new UpdateError(409,'An update is already underway.');
  const latest=await remoteCommit(true);
  if(latest.sha!==sha) throw new UpdateError(409,'A new GitHub commit appeared. Check for updates again.');
  const version=await currentVersion();
  if(compareVersions(latest.version,version)<0) throw new UpdateError(409,'Downgrading the installed version is not allowed.');
  if((await checkForUpdate()).currentSha===sha) throw new UpdateError(409,'This commit is already installed.');
  const relativeData=relative(root,resolve(dataDir));
  if(relativeData==='src' || relativeData.startsWith('src/') || relativeData==='web' || relativeData.startsWith('web/'))
    throw new UpdateError(409,'Move the data directory outside src/ and web/ before updating.');
  installing=true;
  void prepareUpdate(latest,onRestart).catch(async error=>{
    installing=false;
    await writeUpdateStatus(dataDir,'failed',error instanceof Error?error.message:'Update preparation failed.',latest.sha,latest.version).catch(()=>{});
    onFailure();
    console.error('Hearthwave update preparation failed:',error);
  });
}

async function prepareUpdate(latest:RemoteCommit,onRestart:()=>void):Promise<void> {
  let stage:string|undefined;
  let handedOff=false;
  try {
    await writeUpdateStatus(dataDir,'downloading','Downloading the selected public GitHub commit.',latest.sha,latest.version);
    stage=await mkdtemp(join(root,'.hearthwave-update-'));
    await chmod(stage,0o700).catch(()=>{});
    const archive=join(stage,'source.tar.gz');
    const source=join(stage,'source');
    await downloadArchive(latest.sha,archive);
    await writeUpdateStatus(dataDir,'verifying','Verifying every application file against the GitHub tree.',latest.sha,latest.version);
    const expected=await expectedTree(latest.treeSha);
    await extractVerifiedArchive(archive,source,expected);
    const manifest=JSON.parse(await readFile(join(source,'package.json'),'utf8')) as {version?:string};
    if(manifest.version!==latest.version) throw new UpdateError(502,'The archive version changed during download.');
    for(const file of expected.filter(item=>item.path.startsWith('src/') && item.path.endsWith('.ts'))) {
      await execute(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types','--check',join(source,file.path)],{timeout:10000});
    }
    const config={root,dataDir:resolve(dataDir),stage,sha:latest.sha,version:latest.version,oldPid:process.pid,
      port:Number(process.env.PORT||9999),host:process.env.HOST||'0.0.0.0'};
    const configPath=join(stage,'worker-config.json');
    await writeFile(configPath,JSON.stringify(config),{mode:0o600,flag:'wx'});
    const worker=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--experimental-strip-types',join(root,'src/update-worker.ts'),configPath],
      {cwd:root,detached:true,stdio:'ignore',env:process.env});
    await new Promise<void>((resolve,reject)=>{worker.once('spawn',resolve);worker.once('error',reject);});
    worker.unref();
    handedOff=true;
    await writeUpdateStatus(dataDir,'restarting','Verified update is ready; restarting Hearthwave.',latest.sha,latest.version);
    setTimeout(onRestart,2500).unref();
  } finally {
    if(!handedOff && stage) await rm(stage,{recursive:true,force:true}).catch(()=>{});
  }
}
