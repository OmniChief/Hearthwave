/** Load browser playback engines only for streams that use them. */
const libraries = new Map();

export function liveStreamFormat(address) {
  try {
    const url=new URL(address,'http://hearthwave.invalid');
    if (/\.m3u8$/i.test(url.pathname)) return 'HLS';
    if (/\.(?:ts|m2ts)$/i.test(url.pathname)) return 'MPEG-TS';
    for(const name of ['type','format','output','extension','ext']) {
      const hint=url.searchParams.get(name) || '';
      if (/^m3u8$/i.test(hint)) return 'HLS';
      if (/^(?:ts|mpegts|m2ts)$/i.test(hint)) return 'MPEG-TS';
    }
  } catch { /* An invalid URL is handled by the normal playback path. */ }
  return null;
}

export function isHlsUrl(address) { return liveStreamFormat(address)==='HLS'; }

function loadLibrary(name,path) {
  if (globalThis[name]) return Promise.resolve(globalThis[name]);
  if (!libraries.has(name)) {
    const pending=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src=path;
      script.async=true;
      script.onload=()=>globalThis[name] ? resolve(globalThis[name]) : reject(new Error('The playback engine did not initialise.'));
      script.onerror=()=>reject(new Error('The built-in playback engine could not be loaded.'));
      document.head.appendChild(script);
    }).catch(error=>{libraries.delete(name);throw error;});
    libraries.set(name,pending);
  }
  return libraries.get(name);
}

/** Returns a cleanup function. The caller owns playback-generation checks and source fallback. */
export async function prepareMedia(video,address,{ready,fatal,alive,live=false,onEngine=()=>{},onDiagnostic=()=>{}}) {
  const format = liveStreamFormat(address);
  const hls = format === 'HLS';
  // Native media does not need JS access to cross-origin stream bytes.
  // Prefer it only where the device reports support, without changing signed URLs.
  if ((hls && video.canPlayType('application/vnd.apple.mpegurl')) ||
      (live && format==='MPEG-TS' && video.canPlayType('video/mp2t'))) {
    onEngine(hls?'Native HLS':'Native video');
    onDiagnostic('Native playback selected: device reports support for '+format);
    video.src=address;
    video.load();
    ready();
    return () => {};
  }
  if (live && format === 'MPEG-TS') {
    let library;
    try { library=await loadLibrary('mpegts','/vendor/mpegts.js'); }
    catch(error) { if (!video.canPlayType('video/mp2t')) throw error; }
    if (!alive()) return () => {};
    if (library?.getFeatureList().mseLivePlayback) {
      // Provider playback URLs can contain credentials.
      library.LoggingControl.enableAll=false;
      onEngine('mpegts.js');
      onDiagnostic('Browser MPEG-TS engine: cross-origin fetch; credentials omitted');
      const player=library.createPlayer({type:'mpegts',isLive:true,url:address,cors:true,withCredentials:false});
      player.on(library.Events.ERROR,(type,detail,info)=>{
        if (!alive()) return;
        const knownType=Object.keys(library.ErrorTypes||{}).find(key=>library.ErrorTypes[key]===type)||'UNKNOWN';
        const knownDetail=Object.keys(library.ErrorDetails||{}).find(key=>library.ErrorDetails[key]===detail)||'UNKNOWN';
        const status=Number(info?.code);
        const http=knownDetail==='NETWORK_STATUS_CODE_INVALID' && Number.isInteger(status) && status>=100 && status<=599;
        // Never include the upstream message: it may contain a signed URL.
        const message=String(info?.msg||info?.message||'');
        const hint=/cors|cross.origin/i.test(message)?'cross-origin mentioned':/failed to fetch|networkerror|load failed/i.test(message)?'browser fetch rejected':/timeout/i.test(message)?'timeout mentioned':'none';
        onDiagnostic('MPEG-TS '+knownType+' / '+knownDetail+'; HTTP '+(http?status:'not exposed')+'; hint '+hint);
        if (type===library.ErrorTypes.NETWORK_ERROR) {
          fatal(http?'The stream request returned HTTP '+status+'.':'The browser could not read the direct transport stream. Check provider access and CORS.','network');
        } else {
          fatal(detail===library.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED ? 'The provider response was not a supported transport stream.' : 'The browser could not decode the live transport stream.','decode');
        }
      });
      try {
        player.attachMediaElement(video);
        player.load();
        ready();
      } catch(error) { player.destroy();throw error; }
      return () => player.destroy();
    }
    // Give devices with built-in transport stream playback their normal media path.
  }
  const native = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  const path = new URL(address, location.href).pathname;
  const probeHls = live && !format && !native && !/\.(?:mp4|m4v|webm|mp3|aac)$/i.test(path);
  if (!hls && !probeHls) {
    onEngine(video.tagName==='AUDIO'?'Native audio':'Native video');
    video.src=address;
    video.load();
    ready();
    return () => {};
  }


  let Hls;
  try { Hls=await loadLibrary('Hls','/vendor/hls.light.min.js'); }
  catch(error) {if(!native && !probeHls) throw error;}
  if (!alive()) return () => {};
  if (Hls?.isSupported()) {
    onEngine('HLS.js');
    const engine=new Hls({enableWorker:true,maxBufferLength:30,backBufferLength:30});
    let mediaRecovered=false,networkRecovered=false,nativeTried=false;
    const nativeFallback=()=>{
      if((!native && !probeHls) || nativeTried || !alive()) return false;
      nativeTried=true;
      engine.destroy();
      onEngine(probeHls?'Native video':'Native HLS');
      video.src=address;
      video.load();
      ready();
      return true;
    };
    engine.on(Hls.Events.MEDIA_ATTACHED,()=>{if(alive()&&!nativeTried) engine.loadSource(address);});
    engine.on(Hls.Events.MANIFEST_PARSED,()=>{if(alive()&&!nativeTried) ready();});
    engine.on(Hls.Events.ERROR,(_event,data)=>{
      if (!alive() || nativeTried || !data?.fatal) return;
      const detail=Object.values(Hls.ErrorDetails||{}).includes(data.details)?data.details:'unknown';
      const status=Number(data.response?.code);
      onDiagnostic('HLS failure: '+detail+'; HTTP '+(Number.isInteger(status)&&status>=100&&status<=599?status:'not exposed'));
      if (data.type===Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {mediaRecovered=true;engine.recoverMediaError();return;}
      if (data.type===Hls.ErrorTypes.NETWORK_ERROR && !/^manifest/i.test(data.details || '') && !networkRecovered) {networkRecovered=true;engine.startLoad();return;}
      if(nativeFallback()) return;
      const network=data.type===Hls.ErrorTypes.NETWORK_ERROR;
      fatal(network ? 'HLS manifest or segments could not be fetched. The provider may require CORS.' : 'The browser could not decode this HLS stream.',network ? 'hls-network' : data.type===Hls.ErrorTypes.MEDIA_ERROR ? 'decode' : 'unknown');
    });
    try {engine.attachMedia(video);} catch(error) {if(!nativeFallback()) {engine.destroy();throw error;}}
    return () => engine.destroy();
  }
  if (native || probeHls) {
    onEngine(probeHls?'Native video':'Native HLS');
    video.src=address;
    video.load();
    ready();
    return () => {};
  }
  throw new Error('This device has neither native HLS playback nor a compatible MediaSource engine.');
}
