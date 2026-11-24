export function workerPages({page,state,api,esc,notify}){
  let pair=null;
  let busy=false;
  const form=(kind,fields,label)=>'<form class="field-stack" data-worker-form="'+kind+'">'+fields+'<button class="button button-primary" type="submit">'+label+'</button></form>';
  const section=(title,html)=>'<section class="surface"><h2>'+title+'</h2>'+html+'</section>';
  const select=(workers,kind)=>'<label>Worker<select name="workerId" required><option value="">Choose worker</option>'+workers.filter(w=>w.capabilities.includes(kind)).map(w=>'<option value="'+w.id+'">'+esc(w.name)+(w.online?' · online':' · offline')+'</option>').join('')+'</select></label>';
  const refresh='<button class="button button-quiet" data-worker-action="refresh">Refresh status</button>';
  function rows(jobs){
    return jobs.map(j=>'<div class="list-row"><div><strong>'+esc(j.kind+' · '+j.status)+'</strong><small>'+esc(j.worker+' · '+j.username+' · '+new Date(j.updated).toLocaleString())+'</small><small>'+esc(j.message)+'</small></div><div class="row-actions">'+(j.own&&j.file_id&&j.status==='completed'?'<a class="button button-quiet button-small" href="/api/space/files/'+j.file_id+'/download" download>Download</a>':'')+(j.status!=='running'?'<button class="button button-quiet button-small" data-worker-action="delete" data-id="'+j.id+'">'+(j.status==='queued'?'Cancel':'Remove')+'</button>':'')+'</div></div>').join('')||'<p>No jobs yet.</p>';
  }
  async function contents(admin){
    const [workers,jobs]=await Promise.all([api('/api/jobs/workers'),api('/api/jobs'+(admin?'?all=1':''))]);
    const supported=kind=>workers.items.some(w=>w.capabilities.includes(kind));
    if(!admin){
      return section('Creative studio','<p>Generate image and video assets on your paired PC using its configured ComfyUI workflows. The NAS only manages jobs and receives small outputs.</p>'+
        ['image','video'].map(kind=>section(kind==='image'?'Image generation':'Video generation',supported(kind)?form(kind,select(workers.items,kind)+'<label>Prompt<textarea name="prompt" maxlength="4000" required></textarea></label>','Queue '+kind):'<p>No '+kind+'-capable worker is connected. Ask an administrator to configure a '+kind+' workflow.</p>')).join(''))+
        section('Your creative and download history',refresh+rows(jobs.items));
    }
    const workersList=workers.items.map(w=>'<div class="list-row"><div><strong>'+esc(w.name)+'</strong><small>'+esc((w.online?'Online':'Offline')+' · '+(w.capabilities.join(', ')||'No capabilities reported'))+'</small></div><button class="button button-quiet button-small" data-worker-action="revoke" data-id="'+w.id+'">Revoke</button></div>').join('');
    const setup=pair?'<div class="info-banner"><strong>Pairing token (shown once)</strong><p>Keep private. Use HTTPS for remote worker connections. Run the downloaded agent on the worker PC with Node.js 24+.</p><label>Server<input readonly value="'+esc(location.origin)+'"></label><label>Token<input readonly value="'+esc(pair.token)+'"></label><p>PowerShell:</p><textarea readonly rows="5">'+esc("$env:HW_SERVER='"+location.origin+"'\n$env:HW_TOKEN='"+pair.token+"'\nnode --experimental-strip-types hearthwave-worker.ts")+'</textarea><p>For image/video generation, set HW_IMAGE_WORKFLOW and HW_VIDEO_WORKFLOW to ComfyUI API-format JSON files on the worker containing a string input equal to __PROMPT__. Set HW_COMFY_URL if not using localhost:8188. Install FFmpeg on the worker for explicit file conversions.</p><button class="button button-quiet" data-worker-action="dismiss">Hide token</button></div>':'';
    return section('Paired workers','<p>Pair a trusted PC. It polls for work, processes one job at a time and saves output locally. No automatic NAS transcoding.</p><a class="button button-quiet" href="/api/jobs/agent" download>Download worker agent</a>'+form('pair','<label>Worker name<input name="name" maxlength="80" required></label>','Create pairing token')+setup+refresh+workersList)+
      section('Direct file downloads',supported('download')?form('download',select(workers.items,'download')+'<label>Authorised HTTP(S) file URL<input type="url" name="url" maxlength="2048" required></label><label>Output filename<input name="name" maxlength="180" required></label>','Queue download'):'<p>Pair a worker to enable downloads.</p>')+
      section('Explicit file conversion',supported('convert')?form('convert',select(workers.items,'convert')+'<label>Existing filename in worker output folder<input name="name" maxlength="180" required></label><label>Output format<select name="format"><option>mp4</option><option>webm</option><option>mp3</option><option>flac</option></select></label>','Queue conversion'):'<p>Connect a worker with FFmpeg installed.</p>')+
      section('Job queue',refresh+rows(jobs.items));
  }
  async function render(){const html=await contents(false);if(state.page==='create')page.innerHTML=html;}
  async function redraw(){if(state.page==='create')await render();else if(state.page==='settings'&&state.settingsTab==='workers'){const html=await contents(true);const container=page.querySelector('.settings-content');if(container&&state.settingsTab==='workers')container.innerHTML=html;}}
  async function submit(event){
    const f=event.target,kind=f.dataset.workerForm;if(!kind)return;event.preventDefault();if(busy)return;busy=true;
    const b=f.querySelector('button[type=submit]');b.disabled=true;
    try{
      const x=Object.fromEntries(new FormData(f));
      if(kind==='pair')pair=await api('/api/jobs/workers',{method:'POST',body:{name:x.name}});
      else{await api('/api/jobs',{method:'POST',body:{...x,kind,workerId:Number(x.workerId)}});notify('Job queued.');}
      await redraw();
    }catch(e){notify(e.message,true);}finally{busy=false;b.disabled=false;}
  }
  async function click(event){
    const b=event.target.closest('[data-worker-action]');if(!b||busy)return;busy=true;b.disabled=true;
    try{
      const action=b.dataset.workerAction,id=Number(b.dataset.id);
      if(action==='dismiss')pair=null;
      if(action==='revoke'){if(!confirm('Revoke this worker credential?'))return;await api('/api/jobs/workers/'+id,{method:'DELETE'});}
      if(action==='delete')await api('/api/jobs/'+id,{method:'DELETE'});
      await redraw();
    }catch(e){notify(e.message,true);}finally{busy=false;b.disabled=false;}
  }
  return {contents,render,submit,click,reset(){pair=null;}};
}
