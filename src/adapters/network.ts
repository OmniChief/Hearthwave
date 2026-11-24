import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { IncomingHttpHeaders } from 'node:http';

export class ProviderError extends Error {
  status: number;
  retryAt: number | null;
  constructor(message: string, status = 502, retryAt: number | null = null) {
    super(message); this.status = status; this.retryAt = retryAt;
  }
}

// Restrict metadata fetches to public hosts by default. Administrators may opt into
// RFC1918/ULA sources, but never loopback, link-local or cloud metadata addresses.
const alwaysBlocked4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8], ['127.0.0.0',8], ['169.254.0.0',16], ['100.64.0.0',10], ['224.0.0.0',4], ['240.0.0.0',4]] as [string,number][]) alwaysBlocked4.addSubnet(network,prefix,'ipv4');
const private4 = new BlockList();
for (const [network,prefix] of [['10.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16]] as [string,number][]) private4.addSubnet(network,prefix,'ipv4');
const private6 = new BlockList();
private6.addSubnet('fc00::',7,'ipv6');
const global6 = new BlockList();
global6.addSubnet('2000::',3,'ipv6');
const blocked6 = new BlockList();
for (const [network,prefix] of [['2001:db8::',32],['2001::',32],['2002::',16],['::ffff:0:0',96]] as [string,number][]) blocked6.addSubnet(network,prefix,'ipv6');

export function validateProviderUrl(text: string): URL {
  let url: URL;
  try { url = new URL(text); }
  catch { throw new ProviderError('Enter a valid HTTP(S) provider address.',400); }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || /[\x00-\x20\x7f]/.test(text))
    throw new ProviderError('Provider addresses must be plain HTTP(S) URLs without embedded credentials.',400);
  return url;
}

async function pinnedAddress(url: URL, allowLan: boolean): Promise<{ address: string; family: 4 | 6 }> {
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (hostname.toLowerCase() === 'localhost' || hostname.endsWith('.localhost')) throw new ProviderError('Loopback providers are not allowed.',400);
  const addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await lookup(hostname,{all:true,verbatim:true});
  if (!addresses.length || addresses.length > 32) throw new ProviderError('The provider hostname could not be resolved.');
  const allowed = addresses.filter(({address,family}) => {
    if (family === 4) return !alwaysBlocked4.check(address,'ipv4') && (allowLan || !private4.check(address,'ipv4'));
    if (family === 6) return !blocked6.check(address,'ipv6') && (global6.check(address,'ipv6') || (allowLan && private6.check(address,'ipv6')));
    return false;
  });
  // Do not choose one safe address from a DNS set that also contains blocked addresses.
  if (allowed.length !== addresses.length) throw new ProviderError('Provider DNS resolves to a restricted address.',400);
  return allowed[0] as {address:string;family:4|6};
}

let active = 0;
const queued: Array<() => void> = [];
async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 2) {
    if (queued.length >= 20) throw new ProviderError('Too many provider requests are waiting. Try again later.',429);
    await new Promise<void>(resolve => queued.push(resolve));
  }
  active++;
  try { return await task(); }
  finally { active--; queued.shift()?.(); }
}

function retryTime(headers: IncomingHttpHeaders): number {
  const raw = String(headers['retry-after'] || '');
  const seconds = /^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Date.now() + Math.min(3600,Math.max(60,Number.isFinite(seconds) ? seconds : 60)) * 1000;
}

/** HTTP response and decompressed JSON bodies are both size bounded. No redirects. */
export async function providerJson(address: string, options: { headers?: Record<string,string>; allowLan?: boolean; maxBytes?: number; onStatus?: (status:number)=>void } = {}): Promise<unknown> {
  return withSlot(async () => {
    const url = validateProviderUrl(address);
    const { address: ip, family } = await pinnedAddress(url, Boolean(options.allowLan));
    const maxBytes = Math.min(options.maxBytes || 8 * 1024 * 1024, 12 * 1024 * 1024);
    const transport = url.protocol === 'https:' ? https : http;
    const response = await new Promise<http.IncomingMessage>((resolve,reject) => {
      const req = transport.request(url, {
        autoSelectFamily:false,
        method:'GET',signal:AbortSignal.timeout(15000),maxHeaderSize:16 * 1024,
        headers:{'User-Agent':'Hearthwave/0.7','Accept':'application/json','Accept-Encoding':'gzip, deflate, br',...(options.headers || {})},
        lookup:(_hostname,_options,callback) => callback(null,ip,family),
      },resolve);
      req.on('error',reject);
      req.end();
    });
    try {
      options.onStatus?.(response.statusCode || 0);
      if (response.statusCode === 429) throw new ProviderError('Provider rate limit reached (HTTP 429).',429,retryTime(response.headers));
      if (response.statusCode === 401 || response.statusCode === 403) throw new ProviderError('Provider rejected the saved account or device.',502);
      if (response.statusCode !== 200) throw new ProviderError(`Provider returned HTTP ${response.statusCode || 'unknown'}.`);
      const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
      const decoders = {gzip:createGunzip,deflate:createInflate,br:createBrotliDecompress};
      const decode = (decoders as Record<string,()=>NodeJS.ReadWriteStream>)[encoding];
      if (encoding && encoding !== 'identity' && !decode) throw new ProviderError('Unsupported provider response encoding.');
      const stream = decode ? response.pipe(decode()) : response;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of stream) {
        const data = Buffer.from(part);
        size += data.length;
        if (size > maxBytes) throw new ProviderError('Provider response exceeded the catalogue size limit.');
        chunks.push(data);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
      catch { throw new ProviderError('Provider returned invalid JSON.'); }
    } finally { response.destroy(); }
  });
}

/** Stream XMLTV with DNS pinning and decompression limits; never buffer the complete guide in RAM. */
export async function providerXmlStream(address:string, onChunk:(chunk:Buffer)=>void|Promise<void>, options:{allowLan?:boolean}={}):Promise<void> {
  return streamCatalogue(address, onChunk, options, false);
}

export async function fetchM3u(address:string):Promise<string> {
  const chunks: Buffer[] = [];
  await streamCatalogue(address, chunk => { chunks.push(chunk); }, {}, true);
  return Buffer.concat(chunks).toString('utf8');
}

async function openCatalogue(address:string, allowLan:boolean, playlist:boolean) {
  let url=validateProviderUrl(address);
  const origin=url.origin;
  const signal=AbortSignal.timeout(60_000);
  for (let redirects=0; ; redirects++) {
    const {address:ip,family}=await pinnedAddress(url,allowLan && url.origin===origin);
    const transport=url.protocol==='https:' ? https : http;
    const response=await new Promise<http.IncomingMessage>((resolve,reject) => {
      const req=transport.request(url,{
        method:'GET',agent:false,signal,maxHeaderSize:16*1024,
        autoSelectFamily:false,
        headers:{'User-Agent':'Hearthwave','Accept':playlist?'application/x-mpegURL, audio/x-mpegurl, */*':'application/xml, text/xml, application/gzip','Accept-Encoding':'identity'},
        lookup:(_host,_opts,callback)=>callback(null,ip,family),
      },resolve);
      req.on('error',reject);
      req.end();
    });
    if (![301,302,303,307,308].includes(response.statusCode || 0)) return response;
    const location=response.headers.location;
    response.destroy();
    if (!location) throw new ProviderError('Source provider redirected without a destination.');
    if (redirects>=5) throw new ProviderError('Source provider redirected too many times.');
    url=validateProviderUrl(new URL(location,url).href);
  }
}

async function streamCatalogue(address:string, onChunk:(chunk:Buffer)=>void|Promise<void>, options:{allowLan?:boolean}, playlist:boolean):Promise<void> {
  return withSlot(async () => {
    const response=await openCatalogue(address,Boolean(options.allowLan),playlist);
    try {
      if (response.statusCode===429) throw new ProviderError('Source provider rate limit reached (HTTP 429).',429,retryTime(response.headers));
      if (response.statusCode!==200) throw new ProviderError(`Source provider returned HTTP ${response.statusCode || 'unknown'}.`);
      const encoding=String(response.headers['content-encoding'] || '').toLowerCase();
      if (!['','identity','gzip','deflate','br'].includes(encoding)) throw new ProviderError('Unsupported guide response encoding.');
      // Download handlers often serve gzip files as application/force-download without a .gz path.
      const iterator=response[Symbol.asyncIterator]();
      const prefix:Buffer[]=[];
      let length=0;
      while (length<2) {
        const part=await iterator.next();
        if (part.done) break;
        const chunk=Buffer.from(part.value);
        prefix.push(chunk);
        length+=chunk.length;
      }
      const magic=Buffer.concat(prefix,Math.min(length,2));
      const gzip=encoding==='gzip' || magic.equals(Buffer.from([0x1f,0x8b]));
      const decoder=encoding==='br' ? createBrotliDecompress() : encoding==='deflate' ? createInflate() : gzip ? createGunzip() : null;
      const input=Readable.from((async function* () {
        yield* prefix;
        for (let part=await iterator.next(); !part.done; part=await iterator.next()) yield part.value;
      })());
      const fail=(error:Error)=>decoder?.destroy(error);
      if (decoder) input.on('error',fail);
      try {
        const stream=decoder ? input.pipe(decoder) : input;
        let received=0;
        for await (const part of stream) {
          const chunk=Buffer.from(part);
          received+=chunk.length;
          if (playlist && received>11*1024*1024) throw new ProviderError('Playlist exceeds the 11 MB import limit.');
          if (received>128*1024*1024) throw new ProviderError('Guide exceeds the 128 MB decompressed safety limit.');
          await onChunk(chunk);
        }
      } finally {
        input.destroy();
        decoder?.destroy();
      }
    } finally { response.destroy(); }
  });
}

/** Follow redirects and stop as soon as the provider delivers the first media bytes. */
export function checkMediaResponse(address: string, allowLan: boolean): Promise<string> {
  return withSlot(async () => {
    let url = validateProviderUrl(address);
    const origin = url.origin;
    const signal = AbortSignal.timeout(8000);
    for (let hop = 0; hop <= 5; hop++) {
      const pinned = await pinnedAddress(url, allowLan && url.origin === origin);
      const transport = url.protocol === 'https:' ? https : http;
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const request = transport.get(url, {
          agent: false, autoSelectFamily: false, signal,
          headers: { Range: 'bytes=0-' },
          lookup: (_host, _options, done) => done(null, pinned.address, pinned.family),
        }, resolve);
        request.once('error', reject);
      }).catch(() => null);
      if (!response) return 'The provider did not send an HTTP response to a fresh playback request from this server.';
      const status = response.statusCode || 0;
      const headers = response.headers;
      try {
        if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
          url = validateProviderUrl(new URL(headers.location, url).href);
          continue;
        }
        if (status < 200 || status >= 300) return `A fresh playback request to the provider returned HTTP ${status}.`;
        if (status === 204 || headers['content-length'] === '0') return 'The provider returned an empty media response.';
        if (/^text\/html\b/i.test(String(headers['content-type'] || ''))) return 'The provider returned an HTML page when Hearthwave requested media.';
        try {
          for await (const chunk of response) { if (chunk.length) return ''; }
          return 'The provider returned an empty media response.';
        } catch { return 'The fresh provider connection stopped before any media arrived.'; }
      } finally { response.destroy(); }
    }
    return 'The provider redirected the media request too many times.';
  });
}


/** Report only allowlisted error codes, never raw exception messages or addresses. */
function diagnosticNetworkError(error:unknown):string {
  if(error instanceof ProviderError) {
    if(error.message==='Provider DNS resolves to a restricted address.')return 'DNS address blocked by provider safety policy';
    if(error.message==='The provider hostname could not be resolved.')return 'DNS returned no usable address';
    if(error.message==='Loopback providers are not allowed.')return 'Loopback address blocked';
    return 'Provider validation error '+error.status;
  }
  const e=error as {code?:unknown;name?:unknown;cause?:{code?:unknown}};
  const code=String(e?.code||e?.cause?.code||'');
  const known:Record<string,string>={ENOTFOUND:'DNS name not found',EAI_AGAIN:'DNS temporary failure',ECONNREFUSED:'TCP connection refused',ECONNRESET:'Connection reset by peer',EHOSTUNREACH:'Host unreachable',ENETUNREACH:'Network unreachable',ETIMEDOUT:'Connection timed out',ABORT_ERR:'Request deadline exceeded',EPIPE:'Connection closed',ERR_TLS_CERT_ALTNAME_INVALID:'TLS hostname mismatch',CERT_HAS_EXPIRED:'TLS certificate expired',DEPTH_ZERO_SELF_SIGNED_CERT:'TLS self-signed certificate',UNABLE_TO_VERIFY_LEAF_SIGNATURE:'TLS certificate verification failed',ERR_SSL_WRONG_VERSION_NUMBER:'TLS protocol mismatch',HPE_INVALID_CONSTANT:'Invalid HTTP response',HPE_HEADER_OVERFLOW:'HTTP headers too large'};
  if(Object.hasOwn(known,code))return known[code]+' ('+code+')';
  if(e?.name==='TimeoutError'||e?.name==='AbortError')return 'Request deadline exceeded';
  return 'Unclassified transport failure';
}

/** Explicit admin diagnostic: never read, buffer, or relay a media body. */
export async function inspectMediaHeaders(address:string, allowLan:boolean, browserOrigin:string, method:'HEAD'|'GET'='HEAD',options:{sendOrigin?:boolean; userAgent?:string; device?:{origin:string;headers:Record<string,string>}}={}):Promise<string[]> {
  const trace:string[]=['NAS '+method+' header check: fresh link; close at response headers; no media body consumed or forwarded.'];
  try {
    return await withSlot(async()=>{
      let url=validateProviderUrl(address);
      const initialOrigin=url.origin;
      const signal=AbortSignal.timeout(8000);
      for(let hop=0;hop<=5;hop++){
        const started=Date.now();
        let phase='DNS/validation';
        try {
          trace.push(method+' hop '+(hop+1)+': '+url.protocol+' port '+(url.port||(url.protocol==='https:'?'443':'80'))+'; '+(url.origin===browserOrigin?'same browser origin':'cross-origin'));
          const pinned=await pinnedAddress(url,allowLan&&url.origin===initialOrigin);
          trace.push('DNS resolved: IPv'+pinned.family);
          phase='HTTP connection/response';
          const transport=url.protocol==='https:'?https:http;
          const deviceHeaders=options.device?.origin===url.origin?options.device.headers:{};
          trace.push('Request: Origin '+(browserOrigin&&options.sendOrigin!==false?'sent':'omitted')+'; registered device headers '+(Object.keys(deviceHeaders).length?'sent':'not sent'));
          const response=await new Promise<http.IncomingMessage>((resolve,reject)=>{
            const req=transport.request(url,{method,agent:false,autoSelectFamily:false,signal,maxHeaderSize:16*1024,
              headers:{Accept:'*/*',...(options.userAgent?{'User-Agent':options.userAgent}:{}),...(browserOrigin&&options.sendOrigin!==false?{Origin:browserOrigin}:{}),...deviceHeaders},
              lookup:(_host,_options,done)=>done(null,pinned.address,pinned.family)},resolve);
            req.once('error',reject);req.end();
          });
          try {
            const status=response.statusCode||0,headers=response.headers;
            const cors=headers['access-control-allow-origin'];
            const corsHint=cors==='*'?'wildcard':browserOrigin&&cors===browserOrigin?'matches browser origin':cors?'different/invalid origin':'absent';
            const mime=String(headers['content-type']||'').split(';')[0].trim().toLowerCase();
            const mediaType=/^(?:video|audio|application|text)\/[a-z0-9.+-]{1,80}$/.test(mime)?mime:'unknown';
            trace.push('HTTP '+status+'; '+mediaType+'; CORS '+corsHint+'; '+(Date.now()-started)+' ms');
            if([301,302,303,307,308].includes(status)&&headers.location){
              if(hop===5){trace.push('Redirect limit reached.');return trace;}
              phase='Redirect validation';
              const next=validateProviderUrl(new URL(headers.location,url).href);
              trace.push('Redirect: '+next.protocol+'; '+(next.origin===url.origin?'same origin':'different origin'));
              url=next;continue;
            }
            if(method==='HEAD'&&(status===405||status===501))trace.push('HEAD unsupported; use GET header check.');
            else if(status>=200&&status<300&&url.origin!==browserOrigin&&!['wildcard','matches browser origin'].includes(corsHint))trace.push('Cross-origin response lacks matching CORS permission; JS browser playback may fail.');
            return trace;
          } finally {response.destroy();}
        } catch(error) {
          trace.push(phase+' failed after '+(Date.now()-started)+' ms: '+diagnosticNetworkError(error));
          return trace;
        }
      }
      return trace;
    });
  } catch(error) {trace.push(diagnosticNetworkError(error));return trace;}
}
