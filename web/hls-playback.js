/** HLS support lives entirely in the viewer browser; this module is loaded on demand. */
let libraryPromise = null;

export function isHlsUrl(address) {
  try {
    const url=new URL(address,'http://hearthwave.invalid');
    if (/\.m3u8$/i.test(url.pathname)) return true;
    for(const name of ['type','format','output','extension','ext']) {
      if (/^m3u8$/i.test(url.searchParams.get(name) || '')) return true;
    }
  } catch { /* An invalid URL is handled by the normal playback path. */ }
  return false;
}

async function hlsConstructor() {
  if (globalThis.Hls) return globalThis.Hls;
  if (!libraryPromise) {
    libraryPromise=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='/vendor/hls.light.min.js';
      script.async=true;
      script.onload=()=>globalThis.Hls ? resolve(globalThis.Hls) : reject(new Error('The HLS player did not initialise.'));
      script.onerror=()=>reject(new Error('The built-in HLS player could not be loaded.'));
      document.head.appendChild(script);
    }).catch(error=>{libraryPromise=null;throw error;});
  }
  return libraryPromise;
}

/** Returns a cleanup function. The caller owns playback-generation checks and source fallback. */
export async function prepareMedia(video,address,{ready,fatal,alive,onEngine=()=>{}}) {
  if (!isHlsUrl(address)) {
    onEngine('Native video');
    video.src=address;
    video.load();
    ready();
    return () => {};
  }

  const native=Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  let Hls;
  try { Hls=await hlsConstructor(); }
  catch(error) {if(!native) throw error;}
  if (!alive()) return () => {};
  if (Hls?.isSupported()) {
    onEngine('HLS.js');
    const engine=new Hls({enableWorker:true,maxBufferLength:30,backBufferLength:30});
    let mediaRecovered=false,networkRecovered=false,nativeTried=false;
    const nativeFallback=()=>{
      if(!native || nativeTried || !alive()) return false;
      nativeTried=true;
      engine.destroy();
      onEngine('Native HLS');
      video.src=address;
      video.load();
      ready();
      return true;
    };
    engine.on(Hls.Events.MEDIA_ATTACHED,()=>{if(alive()&&!nativeTried) engine.loadSource(address);});
    engine.on(Hls.Events.MANIFEST_PARSED,()=>{if(alive()&&!nativeTried) ready();});
    engine.on(Hls.Events.ERROR,(_event,data)=>{
      if (!alive() || nativeTried || !data?.fatal) return;
      if (data.type===Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {mediaRecovered=true;engine.recoverMediaError();return;}
      if (data.type===Hls.ErrorTypes.NETWORK_ERROR && !networkRecovered) {networkRecovered=true;engine.startLoad();return;}
      if(nativeFallback()) return;
      const network=data.type===Hls.ErrorTypes.NETWORK_ERROR;
      fatal(network ? 'HLS manifest or segments could not be fetched. The provider may require CORS.' : 'The browser could not decode this HLS stream.',network ? 'hls-network' : data.type===Hls.ErrorTypes.MEDIA_ERROR ? 'decode' : 'unknown');
    });
    try {engine.attachMedia(video);} catch(error) {if(!nativeFallback()) {engine.destroy();throw error;}}
    return () => engine.destroy();
  }
  if (native) {
    onEngine('Native HLS');
    video.src=address;
    video.load();
    ready();
    return () => {};
  }
  throw new Error('This device has neither native HLS playback nor a compatible MediaSource engine.');
}
