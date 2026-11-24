import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, realpath, open } from 'node:fs/promises';
import { resolve, join, basename, extname, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const server=(process.env.HW_SERVER||'').replace(/\/+$/,'');
const token=process.env.HW_TOKEN||'';
const output=resolve(process.env.HW_OUTPUT||'hearthwave-output');
const comfy=(process.env.HW_COMFY_URL||'http://127.0.0.1:8188').replace(/\/+$/,'');
const templates={image:process.env.HW_IMAGE_WORKFLOW,video:process.env.HW_VIDEO_WORKFLOW};
const limit=Number(process.env.HW_MAX_BYTES||20*1024**3);
if(!/^https?:\/\//.test(server)||!/^[a-f0-9]{64}$/.test(token)||!Number.isSafeInteger(limit)||limit<=0)throw new Error('Set HW_SERVER, HW_TOKEN and optionally HW_OUTPUT and HW_MAX_BYTES.');
await mkdir(output,{recursive:true});
const root=await realpath(output);
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
type Job={id:number;kind:string;lease:string;payload:Record<string,string>};
async function api(path:string,body:unknown){
  const r=await fetch(server+'/api/worker/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw new Error('Hearthwave request failed: '+r.status+' '+String((await r.json().catch(()=>({}))).error||''));
  return r.json();
}
function safe(value:string){
  if(!value||value==='.'||value==='..'||value!==basename(value)||/[\/\\\x00-\x1f\x7f]/.test(value))throw new Error('Invalid output filename.');
  return value;
}
function run(command:string,args:string[],timeout=3600000):Promise<void>{
  return new Promise((ok,fail)=>{
    const child=spawn(command,args,{stdio:'ignore',windowsHide:true,shell:false});
    const timer=setTimeout(()=>child.kill(),timeout);
    child.once('error',e=>{clearTimeout(timer);fail(e);});
    child.once('exit',code=>{clearTimeout(timer);if(code===0)ok();else fail(new Error(command+' exited with code '+code));});
  });
}
const capabilities=['download'];
if(await run('ffmpeg',['-version'],10000).then(()=>true,()=>false))capabilities.push('convert');
for(const key of ['image','video'] as const){
  if(templates[key]){
    try{const raw=await readFile(templates[key]!,'utf8');JSON.parse(raw);if(!raw.includes('__PROMPT__'))throw Error('Workflow must contain __PROMPT__');capabilities.push(key);}catch(e){console.error('Invalid '+key+' workflow:',e instanceof Error?e.message:e);}
  }
}
async function saveResponse(response:Response,file:string){
  if(!response.ok||!response.body)throw new Error('Remote request failed: '+response.status);
  if(Number(response.headers.get('content-length'))>limit)throw new Error('Download exceeds worker limit.');
  const temp=join(root,'.'+randomUUID()+'.part');
  let total=0;
  try{
    const count=new Transform({transform(chunk,_enc,cb){total+=chunk.length;cb(total>limit?new Error('Download exceeds worker limit.'):null,chunk);}});
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),count,createWriteStream(temp,{flags:'wx'}));
    await rename(temp,file);
  }finally{await rm(temp,{force:true}).catch(()=>{});}
}
function unique(job:Job,filename:string){return join(root,job.id+'-'+randomUUID().slice(0,8)+'-'+safe(filename));}
async function execute(job:Job):Promise<string>{
  const p=job.payload;
  if(job.kind==='download'){
    const file=unique(job,p.name);
    await saveResponse(await fetch(p.url,{signal:AbortSignal.timeout(3600000)}),file);
    return file;
  }
  if(job.kind==='convert'){
    const source=await realpath(join(root,safe(p.name))),rel=relative(root,source);
    if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!(await stat(source)).isFile())throw new Error('Input is not a worker output file.');
    const format=p.format;if(!['mp4','webm','mp3','flac'].includes(format))throw new Error('Invalid conversion format.');
    const filename=unique(job,basename(source,extname(source))+'.'+format);
    const args=format==='mp4'?['-c:v','libx264','-c:a','aac','-movflags','+faststart']:format==='webm'?['-c:v','libvpx-vp9','-c:a','libopus']:format==='mp3'?['-vn','-c:a','libmp3lame']:['-vn','-c:a','flac'];
    try{await run('ffmpeg',['-nostdin','-n','-i',source,...args,filename]);return filename;}catch(e){await rm(filename,{force:true}).catch(()=>{});throw e;}
  }
  if(job.kind!=='image'&&job.kind!=='video')throw new Error('Unsupported job.');
  const template=templates[job.kind];if(!template)throw new Error('Workflow not configured.');
  const raw=JSON.parse(await readFile(template,'utf8'));
  function substitute(value:unknown):unknown{
    if(value==='__PROMPT__')return p.prompt;
    if(value==='__SEED__')return Math.floor(Math.random()*2147483647);
    if(Array.isArray(value))return value.map(substitute);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,substitute(v)]));
    return value;
  }
  const request=await fetch(comfy+'/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:substitute(raw),client_id:randomUUID()}),signal:AbortSignal.timeout(30000)});
  if(!request.ok)throw new Error('ComfyUI rejected the workflow: '+request.status);
  const {prompt_id:id}=await request.json();if(typeof id!=='string')throw new Error('ComfyUI did not return a job ID.');
  const until=Date.now()+3600000;
  while(Date.now()<until){
    await delay(2500);
    const response=await fetch(comfy+'/history/'+encodeURIComponent(id),{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('ComfyUI history request failed.');
    const result=(await response.json())[id];if(!result)continue;
    if(result.status?.status_str==='error')throw new Error('ComfyUI execution failed.');
    const all=Object.values(result.outputs||{}).flatMap((o:any)=>[...(o.images||[]),...(o.gifs||[]),...(o.videos||[])]) as Array<{filename:string;subfolder?:string;type?:string}>;
    const artifact=all.find(a=>a.type==='output'&& (job.kind==='image'?/\.(png|jpe?g|webp)$/i:/\.(mp4|webm|gif|mov)$/i).test(a.filename));
    if(!artifact)throw new Error('Workflow finished without the requested output type.');
    const query=new URLSearchParams({filename:artifact.filename,subfolder:artifact.subfolder||'',type:'output'});
    const file=unique(job,artifact.filename);
    await saveResponse(await fetch(comfy+'/view?'+query,{signal:AbortSignal.timeout(3600000)}),file);
    return file;
  }
  throw new Error('Creative workflow exceeded the time limit.');
}
async function transfer(job:Job,file:string):Promise<string>{
  const size=(await stat(file)).size;
  if(size>64*1024*1024)return 'Saved on worker: '+basename(file)+' (too large for My Space transfer)';
  const path='jobs/'+job.id+'/';
  try{
    const start=await api(path+'begin-file',{lease:job.lease,name:basename(file),size});
    let offset=Number(start.received);
    const handle=await open(file,'r');
    try{
      while(offset<size){
        const data=Buffer.allocUnsafe(Math.min(256*1024,size-offset));
        const {bytesRead}=await handle.read(data,0,data.length,offset);
        if(!bytesRead)throw new Error('Output file ended unexpectedly.');
        offset=Number((await api(path+'chunk',{lease:job.lease,offset,data:data.subarray(0,bytesRead).toString('base64')})).received);
      }
    }finally{await handle.close();}
    return 'Saved on worker and transferred to My Space: '+basename(file);
  }catch(error){throw new Error('Saved on worker as '+basename(file)+'; transfer failed: '+(error instanceof Error?error.message:'unknown error'));}
}
console.log('Hearthwave worker ready: '+root+' · '+capabilities.join(', '));
let lastHeartbeat=0;
while(true){
  try{
    if(Date.now()-lastHeartbeat>=60000){await api('heartbeat',{capabilities});lastHeartbeat=Date.now();}
    const {job}=await api('claim',{}) as {job:Job|null};
    if(!job){await delay(30000);continue;}
    console.log('Running job '+job.id+' ('+job.kind+')');
    const heartbeat=setInterval(()=>{void api('heartbeat',{capabilities}).catch(()=>{});},15000);
    try{
      const file=await execute(job);
      const message=await transfer(job,file);
      await api('jobs/'+job.id+'/result',{lease:job.lease,ok:true,message});
      console.log(message);
    }catch(error){
      const message=String(error instanceof Error?error.message:'Worker job failed.').slice(0,500);
      console.error(message);
      await api('jobs/'+job.id+'/result',{lease:job.lease,ok:false,message}).catch(()=>{});
    }finally{clearInterval(heartbeat);}
  }catch(error){console.error(error instanceof Error?error.message:error);await delay(10000);}
}
