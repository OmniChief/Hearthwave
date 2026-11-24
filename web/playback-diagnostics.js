import { liveStreamFormat } from './hls-playback.js';

/** Format hints based on a URL, never returning its path, host, query or credentials. */
export function streamFormat(address) {
  const liveFormat=liveStreamFormat(address);
  if (liveFormat) return liveFormat;
  let extension='';
  try {extension=new URL(address,'http://hearthwave.invalid').pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';} catch { /* Unknown stream. */ }
  if (extension==='mp4' || extension==='m4v' || extension==='m4a') return 'MP4';
  if (extension==='mkv') return 'Matroska';
  if (extension==='webm') return 'WebM';
  if (extension==='mp3') return 'MP3';
  if (extension==='flac') return 'FLAC';
  return 'Unknown';
}

/** Browser media probes are hints, not promises about a stream or Smart TV decoder. */
export function browserPlaybackCapabilities(video,browser=globalThis) {
  const supports=mime=>{
    try {return video.canPlayType(mime) ? 'Reported' : 'Not reported';}
    catch {return 'Unknown';}
  };
  let mse='Not available';
  try {
    const MediaSource=browser.MediaSource || browser.WebKitMediaSource;
    if(MediaSource?.isTypeSupported) mse=MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') ? 'H.264/AAC reported' : 'Available, codec unconfirmed';
    else if(MediaSource) mse='Available, codec unconfirmed';
  } catch {mse='Unknown';}
  return [
    ['Native HLS',supports('application/vnd.apple.mpegurl')],
    ['Media Source Extensions',mse],
    ['H.264/AAC in MP4',supports('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')],
    ['HEVC/H.265 in MP4',supports('video/mp4; codecs="hvc1.1.6.L93.B0"')],
    ['WebM VP9',supports('video/webm; codecs="vp9"')]
  ];
}

export function nativeMediaFailure(code) {
  switch(code) {
    case 1:return {code:'interrupted',message:'Playback was interrupted.'};
    case 2:return {code:'network',message:'The browser could not retrieve the stream.'};
    case 3:return {code:'decode',message:'The device could not decode the video or audio.'};
    case 4:return {code:'unsupported',message:'This stream URL or format was not supported by the browser.'};
    default:return {code:'unknown',message:'The browser reported an unspecified playback problem.'};
  }
}

export function connectionAdvice(code,format,mixedContent=false) {
  if(mixedContent) return 'This page is HTTPS but the stream uses HTTP. Your browser may block it as mixed content. Choose an HTTPS connection.';
  if(code==='autoplay') return 'The TV or browser requires a button press before playback. Select Play on the video.';
  if(code==='hls-network') return 'HLS loading failed. The provider may require authorisation, block browser CORS requests or have an expired stream link.';
  if(code==='decode') return 'The device could not decode this stream. Try an HD/SD connection, preferably H.264/AAC, or another device.';
  if(code==='unsupported') return 'This browser does not recognise the stream. Try a different connection or a format supported by the TV.';
  if(code==='network' || code==='provider') return 'The stream could not be retrieved. Check the provider connection or choose another available source.';
  if(code==='startup' || code==='stall') return 'The stream stopped making progress. Try a different connection or a lower quality.';
  if(format==='HLS') return 'HLS support and the provider’s CORS policy vary by device. Another connection or native-HLS browser may work.';
  return 'Choose another connection. The format and codecs must be supported by the browser or TV.';
}

/** Report contains only coarse format, type and capability hints, never provider URLs/tokens. */
export function playbackReport(attempts,capabilities) {
  const lines=['Hearthwave playback report',`Connections attempted: ${attempts.length}`];
  attempts.forEach((attempt,index)=>{
    const safeQuality=['4K','FHD','HD','SD','Unknown'].includes(attempt.quality) ? attempt.quality : 'Unknown';
    const safeFormat=['HLS','MP4','Matroska','WebM','MPEG-TS','MP3','FLAC','Unknown'].includes(attempt.format) ? attempt.format : 'Unknown';
    const safeEngine=['HLS.js','mpegts.js','Native HLS','Native video','Native audio','Image viewer','Unresolved'].includes(attempt.engine) ? attempt.engine : 'Unresolved';
    const safeStatus=['Connecting','Preparing','Starting','Playing','Displaying','Buffering','Failed','Switched','Paused'].includes(attempt.status) ? attempt.status : 'Unknown';
    const safeFailure=['interrupted','network','hls-network','decode','unsupported','startup','stall','provider','autoplay','unknown','none'].includes(attempt.failure) ? attempt.failure : 'unknown';
    if(Array.isArray(attempt.trace)){lines.push(`Variant ${attempt.variantId}; source ${attempt.sourceId}`,...attempt.trace);}
    lines.push(`${index+1}. Connection ${attempt.index+1} · ${safeQuality} · ${safeFormat} · ${safeEngine} · ${safeStatus}${safeStatus==='Failed' ? ` (${safeFailure})` : ''}`);
  });
  lines.push('Browser capabilities (hints):');
  capabilities.forEach(([label,value])=>lines.push(`${label}: ${value}`));
  return lines.join('\n');
}
