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
export async function providerJson(address: string, options: { headers?: Record<string,string>; allowLan?: boolean; maxBytes?: number } = {}): Promise<unknown> {
  return withSlot(async () => {
    const url = validateProviderUrl(address);
    const { address: ip, family } = await pinnedAddress(url, Boolean(options.allowLan));
    const maxBytes = Math.min(options.maxBytes || 8 * 1024 * 1024, 12 * 1024 * 1024);
    const transport = url.protocol === 'https:' ? https : http;
    const response = await new Promise<http.IncomingMessage>((resolve,reject) => {
      const req = transport.request(url, {
        method:'GET',signal:AbortSignal.timeout(15000),maxHeaderSize:16 * 1024,
        headers:{'User-Agent':'Hearthwave/0.2','Accept':'application/json','Accept-Encoding':'gzip, deflate, br',...(options.headers || {})},
        lookup:(_hostname,_options,callback) => callback(null,ip,family),
      },resolve);
      req.on('error',reject);
      req.end();
    });
    try {
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
