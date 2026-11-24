import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const directory=process.env.HEARTHWAVE_DATA_DIR||join(root,'data');
let failureRecorded=false;

// Register before loading any application modules. Older updater versions
// truncate the ordinary server log when they restore the previous release.
// Keep one private, independent failure report so even a failed import or bind
// can be diagnosed after an otherwise successful rollback.
function recordFailure(error:unknown):void{
  if(failureRecorded)return;
  failureRecorded=true;
  const reason=error instanceof Error?error.stack||error.message:String(error);
  const safe=reason.replace(/https?:\/\/[^\s'"]+/gi,'[URL redacted]').slice(0,12000);
  try{
    mkdirSync(directory,{recursive:true,mode:0o700});
    writeFileSync(join(directory,'hearthwave-startup-failure.log'),
      new Date().toISOString()+' · pid '+process.pid+'\n'+safe+'\n',{mode:0o600});
  }catch(writeError){console.error('Could not preserve the startup failure:',writeError);}
}
process.on('uncaughtExceptionMonitor',recordFailure);
try{
  await import('./application.ts');
}catch(error){
  recordFailure(error);
  throw error;
}
