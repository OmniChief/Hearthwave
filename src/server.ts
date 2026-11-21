import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { liveGenres, parseM3u, scanFolder } from './catalogue.ts';
import { libraryGenres } from './library-genres.ts';
import { qualityPreferences, type QualityPreference } from './quality.ts';
import { BackupError, backupBusy, streamBackup } from './backup.ts';
import { abortGuideImport, addGuideFeed, addSource, channelGenreCounts, completeImport, countTitles, createUser, dashboardStats, dataDir, db, deleteGuideFeed, deleteSource, enrichTitleMetadata, findUser, getGuideFeed, getGuideMapping, getSource, getTitle, getTitleDetail, getUserPreferences, getVariant, guideGrid, hasUsers, importBatch, libraryGenreCounts, listCategories, listGuideFeeds, listSeriesEpisodes, listSources, listTitles, listVariants, loadSession, publicGuideFeed, publicSource, publicUsers, removeGuideMapping, removeSession, replaceSeriesEpisodes, saveCategories, saveGuideMapping, saveProgress, saveSession, searchGuideChannels, selectCategories, setFavourite, setGuideStatus, setSourceStatus, setUserPreferences, storedGuide, titleExists, type GuideFeed, type SourceRow } from './db.ts';
import { discoverProvider, discoverSeriesEpisodes, fetchTitleMetadata, importProvider, providerGuide, resolveProviderStream, type ProviderScanProgress } from './adapters/providers.ts';
import { importXmltv } from './guide.ts';
import { localSubtitles, subtitleVtt } from './subtitles.ts';
import { ProviderError, validateProviderUrl } from './adapters/network.ts';
import type { GuideProgramme, ImportItem, ProviderCategory, ProviderConfig, SourceType, User } from './model.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const allowedAssets: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/tv-navigation.js': 'tv-navigation.js', '/playback-variants.js': 'playback-variants.js', '/hls-playback.js': 'hls-playback.js', '/vendor/hls.light.min.js': 'vendor/hls.light.min.js',
  '/styles.css': 'styles.css', '/manifest.webmanifest': 'manifest.webmanifest',
  '/sw.js': 'sw.js', '/icon.svg': 'icon.svg',
};
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
const allowedKinds = new Set<SourceType>(['folder', 'm3u', 'xtream', 'stalker', 'direct']);
const inProgress = new Set<number>();
type SourceJobPhase='running'|'cancelling'|'completed'|'cancelled'|'error';
interface SourceJob {
  kind:'scan'|'discover'; phase:SourceJobPhase; started:number; finished:number;
  seen:number; indexed:number; folder:string; folderIndex:number; folderCount:number; page:number; listed:number;
  cancelRequested:boolean; error:string;
}
const sourceJobs=new Map<number,SourceJob>();
function beginSourceJob(id:number,kind:SourceJob['kind']):SourceJob {
  if(sourceJobs.size>=200) for(const [oldId] of sourceJobs) {
    if(!inProgress.has(oldId)) {sourceJobs.delete(oldId);break;}
  }
  const job:SourceJob={kind,phase:'running',started:Date.now(),finished:0,seen:0,indexed:0,folder:'',folderIndex:0,folderCount:0,page:0,listed:0,cancelRequested:false,error:''};
  sourceJobs.set(id,job);
  return job;
}
class ScanCancelled extends Error {constructor(){super('Scan cancelled. Existing catalogue entries were kept.');}}
const failures = new Map<string, { count: number; until: number }>();
const episodeJobs = new Map<number, {status:'running'|'ready'|'error';started:number;finished:number;error:string}>();
const guideCache = new Map<number, {expires:number;programmes:GuideProgramme[];source:string}>();
const importingGuides = new Set<number>();
const refreshingMetadata=new Set<number>();
const metadataLastAttempt=new Map<number,number>();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function strongPassword(password: string): boolean { return password.length >= 12 && password.length <= 256; }
function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}
function verifyPassword(password: string, saved: string): boolean {
  const [salt, digest] = saved.split(':');
  if (!salt || !digest || digest.length !== 128) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function cookieToken(req: IncomingMessage): string | null {
  const match = /(?:^|;\s*)hw_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return match?.[1] || null;
}
function session(req: IncomingMessage): { user: User; csrf: string; tokenHash: string } | null {
  const token = cookieToken(req);
  if (!token) return null;
  const tokenHash = hash(token);
  const result = loadSession(tokenHash);
  return result ? { ...result, tokenHash } : null;
}
function requireUser(req: IncomingMessage): { user: User; csrf: string; tokenHash: string } {
  const current = session(req);
  if (!current) throw new HttpError(401, 'Sign in to continue.');
  return current;
}
function requireWrite(req: IncomingMessage, admin = false): User {
  const current = requireUser(req);
  if (admin && current.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
  if (req.headers['x-csrf-token'] !== current.csrf) throw new HttpError(403, 'Your session needs refreshing. Please reload the page.');
  return current.user;
}
function setCookie(req: IncomingMessage, res: ServerResponse, value: string, age: number): void {
  const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted) || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `hw_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
}
function signIn(req: IncomingMessage, res: ServerResponse, user: User): void {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  saveSession(hash(token), user.id, csrf, Date.now() + 30 * 24 * 60 * 60 * 1000);
  setCookie(req, res, token, 30 * 24 * 60 * 60);
  send(res, 200, { user, csrf, needsSetup: false });
}
async function body(req: IncomingMessage, max = 1024 * 1024): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Expected application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > max) throw new HttpError(413, 'Request exceeds the safety limit.');
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, 'Malformed JSON request.'); }
}
function textField(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new HttpError(400, `Invalid ${label}.`);
  return value.trim();
}
function positiveId(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) throw new HttpError(400, 'Invalid item ID.');
  return number;
}
function streamLocation(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new HttpError(400, 'Stream URLs must be HTTP(S), without embedded passwords.');
  return url.toString();
}
function safelyPublicSource(source: SourceRow): ReturnType<typeof publicSource> {
  const safe = publicSource(source);
  // Locations are visible only to admins; a token-bearing query is still masked in listings.
  if (/^https?:/i.test(safe.location)) {
    try {
      const url = new URL(safe.location);
      if (url.search) url.search = '?[redacted]';
      return { ...safe, location: url.toString() };
    } catch { /* Preserve a non-URL location for diagnostics. */ }
  }
  return safe;
}

function connectionConfig(type: SourceType, raw: unknown): ProviderConfig {
  if (type !== 'xtream' && type !== 'stalker') return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Provider connection details are required.');
  const input = raw as Record<string,unknown>;
  const config: ProviderConfig = {allowLan:input.allowLan === true};
  for (const key of ['username','password','mac','serial','deviceId','deviceId2'] as const) {
    const value = input[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || value.length > 512 || /[\r\n\0]/.test(value)) throw new HttpError(400, `Invalid ${key} value.`);
    config[key] = value.trim();
  }
  if (type === 'xtream' && (!config.username || !config.password)) throw new HttpError(400, 'Xtream username and password are required.');
  if (type === 'stalker' && !/^(?:[A-F\d]{2}:){5}[A-F\d]{2}$/i.test(config.mac || '')) throw new HttpError(400, 'Enter the MAC address registered with the Stalker portal.');
  if (config.mac) config.mac = config.mac.toUpperCase();
  return config;
}

function startImport(source: SourceRow, items: AsyncIterable<ImportItem>): void {
  if (inProgress.has(source.id)) throw new HttpError(409, 'This source is already being imported.');
  inProgress.add(source.id);
  const job=beginSourceJob(source.id,'scan');
  setSourceStatus(source.id, 'scanning');
  const generation = randomUUID();
  void (async () => {
    try {
      let buffer: ImportItem[] = [];
      let seen = 0;
      for await (const item of items) {
        if(job.cancelRequested) throw new ScanCancelled();
        if (++seen > 50_000) throw new Error('This scan exceeds the 50,000-item source limit. Select fewer categories and retry.');
        job.seen=seen;
        buffer.push(item);
        if (buffer.length === 128) {
          importBatch(source.id, buffer, generation);
          job.indexed+=buffer.length;
          buffer = [];
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      if(job.cancelRequested) throw new ScanCancelled();
      if (buffer.length) {importBatch(source.id, buffer, generation);job.indexed+=buffer.length;}
      completeImport(source.id, generation);
      job.phase='completed';
    } catch (error) {
      const cancelled=job.cancelRequested || error instanceof ScanCancelled;
      job.phase=cancelled?'cancelled':'error';
      job.error=cancelled?'Scan cancelled. Existing catalogue entries were kept.':error instanceof Error?error.message.slice(0,300):'Scan failed.';
      setSourceStatus(source.id,cancelled?'cancelled':error instanceof ProviderError && error.status === 429 ? 'rate_limited' : 'error',job.error);
      if(!cancelled) console.error(`Import of source ${source.id} failed:`, error);
    } finally {job.finished=Date.now();inProgress.delete(source.id);}
  })();
}

function startDiscovery(source: SourceRow): void {
  if (inProgress.has(source.id)) throw new HttpError(409, 'This source is already busy.');
  inProgress.add(source.id);
  const job=beginSourceJob(source.id,'discover');
  setSourceStatus(source.id,'discovering');
  void (async () => {
    try {
      const categories = await discoverProvider(source);
      saveCategories(source.id,categories);
      job.seen=categories.length;
      job.phase='completed';
      setSourceStatus(source.id,'categories_ready');
    } catch (error) {
      job.phase='error';
      job.error=error instanceof Error ? error.message.slice(0,300) : 'Provider discovery failed.';
      setSourceStatus(source.id,error instanceof ProviderError && error.status === 429 ? 'rate_limited' : 'error',job.error);
      console.error(`Provider discovery failed for source ${source.id}:`,error instanceof Error ? error.message : 'Unknown error');
    } finally {job.finished=Date.now();inProgress.delete(source.id);}
  })();
}

function startEpisodeDiscovery(seriesId: number): void {
  const current = episodeJobs.get(seriesId);
  if (current?.status === 'running') throw new HttpError(409,'Episodes are already being retrieved.');
  if (current && Date.now() - current.started < 60_000) throw new HttpError(429,'Wait one minute before refreshing this show again.');
  if ([...episodeJobs.values()].filter(job=>job.status === 'running').length >= 3) throw new HttpError(429,'Episode lookups are busy. Please try again shortly.');
  const show = getTitle(seriesId);
  if (!show || show.kind !== 'series') throw new HttpError(404,'Series not found.');
  const variants = listVariants(seriesId).filter(row=>row.url.startsWith('xtream-series:') || row.url.startsWith('stalker-series:')).slice(0,8);
  if (!variants.length) throw new HttpError(404,'This series has no supported provider connection.');
  episodeJobs.set(seriesId,{status:'running',started:Date.now(),finished:0,error:''});
  if (episodeJobs.size > 500) {
    for (const [id,job] of episodeJobs) { if (id !== seriesId && job.status !== 'running') { episodeJobs.delete(id); break; } }
  }
  void (async () => {
    const grouped = new Map<number,typeof variants>();
    for (const variant of variants) grouped.set(variant.source_id,[...(grouped.get(variant.source_id) || []),variant]);
    let successful = 0;
    const errors: string[] = [];
    for (const [sourceId,sourceVariants] of grouped) {
      const source = getSource(sourceId);
      if (!source) continue;
      try {
        const collected: ImportItem[] = [];
        for (const variant of sourceVariants) collected.push(...await discoverSeriesEpisodes(source,variant.url,show.title,show.year));
        if (!collected.length) throw new ProviderError('Provider returned no playable episodes; existing episodes were kept.');
        replaceSeriesEpisodes(seriesId,sourceId,collected);
        successful++;
      } catch (error) {
        errors.push(`${source.name}: ${error instanceof Error ? error.message.slice(0,180) : 'Could not load episodes.'}`);
      }
    }
    episodeJobs.set(seriesId,{status:successful ? 'ready' : 'error',started:episodeJobs.get(seriesId)?.started || Date.now(),finished:Date.now(),error:errors.join(' · ').slice(0,350)});
  })();
}

function startGuideImport(feed:GuideFeed):void {
  if (importingGuides.has(feed.id)) throw new HttpError(409,'This guide is already importing.');
  if (importingGuides.size>=1) throw new HttpError(429,'Only one guide can import at a time on a low-memory server.');
  const address=new URL(feed.location);
  const previous=feed.last_import ? Date.parse(feed.last_import.replace(' ','T')+'Z') : NaN;
  if (/(?:^|\.)open-epg\.com$/i.test(address.hostname) && Number.isFinite(previous) && Date.now()-previous<6*3600_000)
    throw new HttpError(429,'Open-EPG only updates daily. Wait at least six hours between successful imports of this feed.');
  importingGuides.add(feed.id);
  setGuideStatus(feed.id,'importing');
  const generation=randomUUID();
  void (async()=>{
    try {
      const result=await importXmltv(feed,generation);
      guideCache.clear();
      console.log(`Guide ${feed.id} imported: ${result.channels} channels, ${result.programmes} programmes`);
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Guide import failed.';
      abortGuideImport(feed.id,generation,message);
      console.error(`Guide ${feed.id} import failed:`,message);
    } finally { importingGuides.delete(feed.id); }
  })();
}

async function* arrayItems(items: ImportItem[]): AsyncGenerator<ImportItem> {
  for (const item of items) yield item;
}

async function serveLocal(req: IncomingMessage, res: ServerResponse, variantId: number): Promise<void> {
  const variant = getVariant(variantId);
  if (!variant || variant.source_type !== 'folder') throw new HttpError(404, 'Local media not found.');
  const root = await realpath(variant.source_location);
  const file = await realpath(variant.url);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HttpError(403, 'The media file is outside its configured folder.');
  const info = await stat(file);
  if (!info.isFile()) throw new HttpError(404, 'Media file unavailable.');
  const total = info.size;
  const range = req.headers.range;
  let start = 0;
  let end = total - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'Unsupported range.');
    if (!match[1]) start = Math.max(0, total - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total || end < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
    }
    end = Math.min(end, total - 1);
  }
  const headers: Record<string, string | number> = {
    'Content-Type': contentTypes[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(range ? 206 : 200, headers);
  const stream = createReadStream(file, { start, end });
  stream.on('error', error => { console.error('Local playback failed:', error); res.destroy(error); });
  stream.pipe(res);
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method || 'GET';
  if (path === '/api/health' && method === 'GET') return send(res, 200, { ok: true, name: 'Hearthwave', version: '0.16.0' });
  if (path === '/api/session' && method === 'GET') {
    const current = session(req);
    return send(res, 200, { needsSetup: !hasUsers(), user: current?.user || null, csrf: current?.csrf || null });
  }
  if (path === '/api/setup' && method === 'POST') {
    if (hasUsers()) throw new HttpError(409, 'The administrator account already exists.');
    const input = await body(req);
    if (hasUsers()) throw new HttpError(409, 'The administrator account already exists.');
    const username = textField(input.username, 'username', 50);
    const password = textField(input.password, 'password', 256);
    if (!/^[\p{L}\p{N}_.-]{3,50}$/u.test(username) || !strongPassword(password)) throw new HttpError(400, 'Use a 3–50-character username and a password of at least 12 characters.');
    try {
      const user = createUser(username, passwordHash(password), 'admin');
      return signIn(req, res, user);
    } catch { throw new HttpError(409, 'The setup account could not be created.'); }
  }
  if (path === '/api/login' && method === 'POST') {
    const remote = req.socket.remoteAddress || 'unknown';
    const entry = failures.get(remote);
    const attempts = entry && Date.now() < entry.until ? entry.count : 0;
    if (attempts >= 5) throw new HttpError(429, 'Too many attempts. Try again in one minute.');
    const input = await body(req);
    const username = textField(input.username, 'username', 50);
    const password = textField(input.password, 'password', 256);
    const user = findUser(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      failures.set(remote, { count: attempts + 1, until: Date.now() + 60_000 });
      if (failures.size > 1000) failures.clear();
      throw new HttpError(401, 'Username or password is incorrect.');
    }
    failures.delete(remote);
    return signIn(req, res, { id: user.id, username: user.username, role: user.role });
  }
  if (path === '/api/logout' && method === 'POST') {
    const current = requireUser(req);
    requireWrite(req);
    removeSession(current.tokenHash);
    setCookie(req, res, '', 0);
    return send(res, 200, { ok: true });
  }

  const current = requireUser(req);
  if (path === '/api/system/status' && method === 'GET') {
    if (current.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
    const databaseInfo = await stat(join(dataDir, 'hearthwave.sqlite'));
    return send(res, 200, { version: '0.16.0', schema: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, databaseBytes: databaseInfo.size, rssBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(process.uptime()), backupBusy: backupBusy() });
  }
  if (path === '/api/system/backup' && method === 'POST') {
    requireWrite(req, true);
    return streamBackup(res);
  }
  if (path === '/api/preferences' && method === 'GET') return send(res,200,getUserPreferences(current.user.id));
  if (path === '/api/preferences' && method === 'POST') {
    requireWrite(req);
    const input=await body(req);
    const autoChanged=Object.hasOwn(input,'autoplayNext'),qualityChanged=Object.hasOwn(input,'qualityPreference');
    if (!autoChanged && !qualityChanged) throw new HttpError(400,'Specify a playback preference to update.');
    if (autoChanged && typeof input.autoplayNext !== 'boolean') throw new HttpError(400,'Autoplay next must be true or false.');
    if (qualityChanged && (typeof input.qualityPreference !== 'string' || !qualityPreferences.includes(input.qualityPreference as QualityPreference))) throw new HttpError(400,'Unknown playback quality preference.');
    const previous=getUserPreferences(current.user.id);
    return send(res,200,setUserPreferences(current.user.id,autoChanged?input.autoplayNext as boolean:previous.autoplayNext,qualityChanged?input.qualityPreference as QualityPreference:previous.qualityPreference));
  }
  if (path === '/api/stats' && method === 'GET') return send(res, 200, dashboardStats());
  if (path === '/api/users' && method === 'GET') {
    if (current.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
    return send(res, 200, { users: publicUsers() });
  }
  if (path === '/api/users' && method === 'POST') {
    requireWrite(req, true);
    const input = await body(req);
    const username = textField(input.username, 'username', 50);
    const password = textField(input.password, 'password', 256);
    if (!/^[\p{L}\p{N}_.-]{3,50}$/u.test(username) || !strongPassword(password)) throw new HttpError(400, 'Use a valid username and a password of at least 12 characters.');
    try { return send(res, 201, { user: createUser(username, passwordHash(password), input.role === 'admin' ? 'admin' : 'viewer') }); }
    catch { throw new HttpError(409, 'This username is already in use.'); }
  }
  if (path === '/api/sources' && method === 'GET') {
    if (current.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
    return send(res, 200, { sources: listSources().map(safelyPublicSource),jobs:Object.fromEntries(sourceJobs) });
  }
  if (path === '/api/sources' && method === 'POST') {
    requireWrite(req, true);
    const input = await body(req);
    const type = textField(input.type, 'source type', 30) as SourceType;
    if (!allowedKinds.has(type)) throw new HttpError(400, 'Unsupported source type.');
    const name = textField(input.name, 'source name', 100);
    let location = ['folder','direct','xtream','stalker'].includes(type) ? textField(input.location, 'source location', 2048) : (typeof input.location === 'string' ? input.location.trim() : '');
    if (type === 'folder') {
      if (!isAbsolute(location)) throw new HttpError(400, 'Local folder paths must be absolute.');
      location = await realpath(location);
      if (!(await stat(location)).isDirectory()) throw new HttpError(400, 'The folder is not a directory.');
    }
    if (type === 'direct') location = streamLocation(location);
    if (type === 'm3u' && location) location = streamLocation(location);
    if (type === 'xtream' || type === 'stalker') {
      const url = validateProviderUrl(location);
      if (url.search || url.hash) throw new HttpError(400, 'Enter the provider server URL without a query string.');
      location = url.toString().replace(/\/$/,'');
    }
    const config = connectionConfig(type,input.config);
    const source = addSource({ name, type, location, config });
    if (type === 'direct') {
      const generation = randomUUID();
      importBatch(source.id, [{ kind: 'channel', title: name, sourceRef: 'direct', url: location }], generation);
      completeImport(source.id, generation);
    }
    return send(res, 201, { source: safelyPublicSource(getSource(source.id)!) });
  }
  const sourceMatch = /^\/api\/sources\/(\d+)(?:\/(import|scan|discover|categories|cancel))?$/.exec(path);
  if (sourceMatch) {
    const id = positiveId(sourceMatch[1]);
    const source = getSource(id);
    if (!source) throw new HttpError(404, 'Source not found.');
    if (method === 'DELETE' && !sourceMatch[2]) {
      requireWrite(req, true);
      if (inProgress.has(id)) throw new HttpError(409, 'Wait for this scan to finish before removing the source.');
      deleteSource(id);
      sourceJobs.delete(id);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && sourceMatch[2] === 'cancel') {
      requireWrite(req,true);
      const job=sourceJobs.get(id);
      if(!job || job.kind!=='scan' || !inProgress.has(id) || !['running','cancelling'].includes(job.phase)) throw new HttpError(409,'There is no active scan to cancel.');
      job.cancelRequested=true;
      job.phase='cancelling';
      setSourceStatus(id,'cancelling');
      return send(res,202,{status:'cancelling'});
    }
    if (method === 'POST' && sourceMatch[2] === 'import') {
      requireWrite(req, true);
      if (source.type !== 'm3u') throw new HttpError(400, 'Only M3U sources accept playlist imports.');
      const input = await body(req, 12 * 1024 * 1024);
      const playlist = textField(input.playlist, 'playlist', 11 * 1024 * 1024);
      let items: ImportItem[];
      try { items = parseM3u(playlist); }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid playlist.'); }
      startImport(source, arrayItems(items));
      return send(res, 202, { status: 'scanning', accepted: items.length });
    }
    if (method === 'POST' && sourceMatch[2] === 'scan') {
      requireWrite(req, true);
      if (source.type === 'folder') startImport(source, scanFolder(source.location));
      else if (source.type === 'stalker' || source.type === 'xtream') {
        const selected = listCategories(id).filter(row=>row.selected === 1);
        if (!selected.length) throw new HttpError(400, 'Select provider categories in Settings before scanning.');
        startImport(source, importProvider(source,selected,(progress:ProviderScanProgress)=>{
          const job=sourceJobs.get(id);
          if(job && job.kind==='scan') Object.assign(job,progress);
        }));
      } else throw new HttpError(400, 'This source does not support scanning.');
      return send(res, 202, { status: 'scanning' });
    }
    if (method === 'POST' && sourceMatch[2] === 'discover') {
      requireWrite(req,true);
      if (!['stalker','xtream'].includes(source.type)) throw new HttpError(400, 'This source has no remote categories.');
      startDiscovery(source);
      return send(res, 202, { status:'discovering' });
    }
    if (method === 'GET' && sourceMatch[2] === 'categories') {
      if (current.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
      return send(res, 200, {categories:listCategories(id)});
    }
    if (method === 'POST' && sourceMatch[2] === 'categories') {
      requireWrite(req,true);
      if (inProgress.has(id)) throw new HttpError(409, 'Wait until provider discovery or scanning finishes.');
      const input = await body(req);
      if (!Array.isArray(input.selected) || input.selected.length > 3000) throw new HttpError(400, 'Invalid provider category selection.');
      const selected = input.selected.map((row: unknown) => {
        if (!row || typeof row !== 'object') throw new HttpError(400, 'Invalid category selection.');
        const {kind,id:categoryId} = row as {kind:unknown;id:unknown};
        if (!['live','vod','series'].includes(String(kind)) || typeof categoryId !== 'string' || categoryId.length > 80) throw new HttpError(400, 'Invalid category selection.');
        return {kind,id:categoryId} as {kind:ProviderCategory['kind'];id:string};
      });
      try { selectCategories(id,selected); }
      catch (error) { throw new HttpError(409,error instanceof Error ? error.message : 'Could not update category selections.'); }
      return send(res, 200, {categories:listCategories(id)});
    }
  }
  if (path === '/api/guide/feeds' && method === 'GET') {
    if (current.user.role !== 'admin') throw new HttpError(403,'Administrator access required.');
    return send(res,200,{feeds:listGuideFeeds().map(publicGuideFeed)});
  }
  if (path === '/api/guide/feeds' && method === 'POST') {
    requireWrite(req,true);
    const input=await body(req);
    const name=textField(input.name,'guide name',100);
    const country=String(input.country || '');
    if (!['GB','US',''].includes(country)) throw new HttpError(400,'Choose a supported guide region.');
    const url=validateProviderUrl(textField(input.location,'XMLTV URL',2048));
    return send(res,201,{feed:publicGuideFeed(addGuideFeed(name,country,url.toString()))});
  }
  const guideFeedMatch=/^\/api\/guide\/feeds\/(\d+)(?:\/(import))?$/.exec(path);
  if (guideFeedMatch) {
    const id=positiveId(guideFeedMatch[1]);
    const feed=getGuideFeed(id);
    if (!feed) throw new HttpError(404,'Guide feed not found.');
    if (method==='POST' && guideFeedMatch[2]==='import') {
      requireWrite(req,true);
      startGuideImport(feed);
      return send(res,202,{status:'importing'});
    }
    if (method==='DELETE' && !guideFeedMatch[2]) {
      requireWrite(req,true);
      if (importingGuides.has(id)) throw new HttpError(409,'Wait for this guide import to finish before removing it.');
      deleteGuideFeed(id);
      guideCache.clear();
      return send(res,200,{ok:true});
    }
  }
  if (path==='/api/guide/grid' && method==='GET') {
    const country=url.searchParams.get('country') || '';
    if (!['','GB','US'].includes(country)) throw new HttpError(400,'Unknown guide region.');
    const limit=Math.floor(Math.min(60,Math.max(1,Number(url.searchParams.get('limit') || 30) || 30)));
    const offsetValue=Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offsetValue) || offsetValue<0 || offsetValue>20000) throw new HttpError(400,'Invalid guide page.');
    const now=Math.floor(Date.now()/1000);
    const startValue=url.searchParams.get('start'),endValue=url.searchParams.get('end');
    if ((startValue===null)!==(endValue===null)) throw new HttpError(400,'Specify both guide window times.');
    const start=startValue===null ? Math.floor(now/(6*3600))*6*3600 : Number(startValue);
    const end=endValue===null ? start+6*3600 : Number(endValue);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<now-2*86400 || start>now+10*86400 || end<=start || end-start<5*3600 || end-start>7*3600 || end>now+11*86400)
      throw new HttpError(400,'Choose a six-hour guide window within the imported programme range.');
    return send(res,200,{...guideGrid(country,limit,(url.searchParams.get('q') || '').slice(0,120),offsetValue,start,end),country,offset:offsetValue,limit,start,end});
  }
  if (path==='/api/guide/channels' && method==='GET') {
    if (current.user.role!=='admin') throw new HttpError(403,'Administrator access required.');
    return send(res,200,{channels:searchGuideChannels((url.searchParams.get('q') || '').slice(0,120))});
  }
  if (path === '/api/catalogue' && method === 'GET') {
    const kind = url.searchParams.get('kind') || 'all';
    if (!['all', 'library', 'film', 'series', 'episode', 'channel', 'music', 'photo'].includes(kind)) throw new HttpError(400, 'Unsupported media kind.');
    const query = (url.searchParams.get('q') || '').slice(0, 120);
    const view=url.searchParams.get('view') || 'all';
    const sort=url.searchParams.get('sort') || 'title';
    if(!['all','favourites','continue'].includes(view) || !['title','year','added','activity'].includes(sort)) throw new HttpError(400,'Unknown Library filter or sort order.');
    const limit=Math.min(250,Math.max(1,Math.floor(Number(url.searchParams.get('limit') || 250) || 250)));
    const offset=Number(url.searchParams.get('offset') || 0);
    if(!Number.isSafeInteger(offset) || offset<0 || offset>1_000_000) throw new HttpError(400,'Invalid catalogue page.');
    const country=url.searchParams.get('country') || '';
    const genre=url.searchParams.get('genre') || '';
    if (country && kind!=='channel') throw new HttpError(400,'Country filters apply only to Live channels.');
    if (!['','GB','US','other'].includes(country)) throw new HttpError(400,'Unknown Live country filter.');
    if (genre && (kind==='channel' ? !liveGenres.includes(genre as typeof liveGenres[number]) : !['library','film','series'].includes(kind) || !libraryGenres.includes(genre as typeof libraryGenres[number]))) throw new HttpError(400,'Unknown genre filter for this catalogue.');
    const typedKind=kind as 'all'|'library'|ImportItem['kind'];
    const typedView=view as 'all'|'favourites'|'continue',typedSort=sort as 'title'|'year'|'added'|'activity';
    const liveGenre=kind==='channel'?genre:'',libraryGenre=kind==='channel'?'':genre;
    return send(res,200,{
      items:listTitles(typedKind,current.user.id,query,typedView,typedSort,limit,offset,country,liveGenre,libraryGenre),
      total:countTitles(typedKind,current.user.id,query,typedView,country,liveGenre,libraryGenre),
      offset,limit,maxResults:limit,
      genres:kind==='channel'?channelGenreCounts(country,query):['library','film','series'].includes(kind)?libraryGenreCounts(kind as 'library'|'film'|'series',current.user.id,query,typedView):[],
    });
  }
  const detailMatch=/^\/api\/titles\/(\d+)$/.exec(path);
  if (detailMatch && method==='GET') {
    const title=getTitleDetail(positiveId(detailMatch[1]),current.user.id);
    if (!title) throw new HttpError(404,'Title not found.');
    return send(res,200,{title});
  }
  const metadataMatch=/^\/api\/titles\/(\d+)\/metadata\/refresh$/.exec(path);
  if(metadataMatch && method==='POST') {
    requireWrite(req,true);
    const titleId=positiveId(metadataMatch[1]);
    if(!['film','series'].includes(getTitle(titleId)?.kind || '')) throw new HttpError(404,'Film or series not found.');
    if(refreshingMetadata.has(titleId) || refreshingMetadata.size>=2) throw new HttpError(409,'Another metadata refresh is already running.');
    if(Date.now()-(metadataLastAttempt.get(titleId)||0)<60_000) throw new HttpError(429,'Wait one minute before refreshing this title again.');
    refreshingMetadata.add(titleId);
    try {
      const seen=new Set<number>();
      const variants=listVariants(titleId).filter(v=>{
        if(!['xtream','stalker'].includes(v.source_type) || !/^(vod|series):/.test(v.source_ref) || seen.has(v.source_id)) return false;
        seen.add(v.source_id);return true;
      }).slice(0,3);
      if(!variants.length) return send(res,200,{updated:false,providers:0,title:getTitleDetail(titleId,current.user.id)});
      if(metadataLastAttempt.size>300) metadataLastAttempt.clear();
      metadataLastAttempt.set(titleId,Date.now());
      let updated=0;
      const failures:Error[]=[];
      for(const variant of variants) {
        const source=getSource(variant.source_id);
        if(!source) continue;
        try {
          const info=await fetchTitleMetadata(source,variant.source_ref);
          if(info && enrichTitleMetadata(titleId,info)) updated++;
        } catch(error) { failures.push(error instanceof Error?error:new Error('Provider metadata lookup failed.')); }
      }
      if(!updated && failures.length) {
        const throttled=failures.every(error=>error instanceof ProviderError && error.status===429);
        throw new HttpError(throttled?429:502,throttled?'A provider is rate-limiting metadata requests. Try later.':'Provider metadata lookup failed. Existing details were kept.');
      }
      return send(res,200,{updated:updated>0,providers:updated,title:getTitleDetail(titleId,current.user.id)});
    } finally {refreshingMetadata.delete(titleId);}
  }
  const mappingMatch=/^\/api\/titles\/(\d+)\/guide\/mapping$/.exec(path);
  if (mappingMatch) {
    const titleId=positiveId(mappingMatch[1]);
    if (getTitle(titleId)?.kind!=='channel') throw new HttpError(404,'Live channel not found.');
    if (method==='GET') {
      if (current.user.role!=='admin') throw new HttpError(403,'Administrator access required.');
      return send(res,200,{mapping:getGuideMapping(titleId) || null});
    }
    if (method==='POST') {
      requireWrite(req,true);
      const input=await body(req);
      const feedId=positiveId(String(input.feedId || ''));
      const channelId=textField(input.channelId,'XMLTV channel ID',300);
      try { saveGuideMapping(titleId,feedId,channelId); }
      catch (error) { throw new HttpError(400,error instanceof Error ? error.message : 'Invalid guide mapping.'); }
      guideCache.delete(titleId);
      return send(res,200,{mapping:getGuideMapping(titleId)});
    }
    if (method==='DELETE') {
      requireWrite(req,true);
      removeGuideMapping(titleId);
      guideCache.delete(titleId);
      return send(res,200,{ok:true});
    }
  }
  const episodesMatch = /^\/api\/titles\/(\d+)\/episodes(?:\/(refresh))?$/.exec(path);
  if (episodesMatch) {
    const titleId = positiveId(episodesMatch[1]);
    const title = getTitle(titleId);
    if (!title || title.kind !== 'series') throw new HttpError(404,'Series not found.');
    if (method === 'GET' && !episodesMatch[2]) {
      return send(res,200,{series:title,items:listSeriesEpisodes(titleId,current.user.id),status:episodeJobs.get(titleId) || {status:'idle',error:''}});
    }
    if (method === 'POST' && episodesMatch[2] === 'refresh') {
      requireWrite(req);
      startEpisodeDiscovery(titleId);
      return send(res,202,{status:'running'});
    }
  }
  const guideMatch = /^\/api\/titles\/(\d+)\/guide$/.exec(path);
  if (guideMatch && method === 'GET') {
    const titleId = positiveId(guideMatch[1]);
    if (getTitle(titleId)?.kind !== 'channel') throw new HttpError(404,'Live channel not found.');
    const xmltv=storedGuide(titleId);
    if (xmltv.programmes.length) return send(res,200,{...xmltv,cached:true,kind:'xmltv'});
    const cached = guideCache.get(titleId);
    if (cached && cached.expires > Date.now()) return send(res,200,{programmes:cached.programmes,source:cached.source,cached:true});
    const variants = listVariants(titleId).filter(v=>['stalker','xtream'].includes(v.source_type)).slice(0,2);
    let programmes: GuideProgramme[] = [];
    let sourceName = '';
    for (const variant of variants) {
      const source = getSource(variant.source_id);
      if (!source) continue;
      try {
        programmes = await providerGuide(source,variant.source_ref);
        if (programmes.length) { sourceName = source.name; break; }
      } catch (error) {
        if (error instanceof ProviderError && error.status === 429) break;
        console.error(`Guide lookup failed for source ${source.id}:`,error instanceof Error ? error.message : 'Unknown error');
      }
    }
    guideCache.set(titleId,{expires:Date.now()+5*60_000,programmes,source:sourceName});
    if (guideCache.size > 100) guideCache.delete(guideCache.keys().next().value!);
    return send(res,200,{programmes,source:sourceName,cached:false});
  }
  const variantMatch = /^\/api\/titles\/(\d+)\/variants$/.exec(path);
  if (variantMatch && method === 'GET') {
    const titleId = positiveId(variantMatch[1]);
    if (!titleExists(titleId)) throw new HttpError(404, 'Title not found.');
    return send(res, 200, { variants: listVariants(titleId).map(v => ({
      id: v.id, sourceId:v.source_id, name: v.source_name, quality: v.quality, qualityTier:v.quality_tier, qualityRank:v.quality_rank, group:v.group_name, type: v.source_type,
      playable:!v.url.startsWith('xtream-series:') && !v.url.startsWith('stalker-series:'),
      resolve:v.source_type === 'stalker' && v.url.startsWith('stalker:'),
      url:v.source_type === 'folder' ? `/api/media/${v.id}/file` : v.source_type === 'stalker' ? null : v.url.startsWith('xtream-series:') ? null : v.url,
    })) });
  }
  const resolveMatch = /^\/api\/variants\/(\d+)\/resolve$/.exec(path);
  if (resolveMatch && method === 'POST') {
    requireWrite(req);
    const variant = getVariant(positiveId(resolveMatch[1]));
    if (!variant) throw new HttpError(404,'Source version not found.');
    const source = getSource(variant.source_id);
    if (!source) throw new HttpError(404,'Source connection not found.');
    const stream = await resolveProviderStream(source,variant.url);
    return send(res,200,{url:stream});
  }
  const favouriteMatch = /^\/api\/titles\/(\d+)\/favourite$/.exec(path);
  if (favouriteMatch && method === 'POST') {
    requireWrite(req);
    const titleId = positiveId(favouriteMatch[1]);
    if (!titleExists(titleId)) throw new HttpError(404, 'Title not found.');
    const input = await body(req);
    if (typeof input.favourite !== 'boolean') throw new HttpError(400, 'Expected a favourite boolean.');
    setFavourite(current.user.id, titleId, input.favourite);
    return send(res, 200, { favourite: input.favourite });
  }
  const progressMatch = /^\/api\/titles\/(\d+)\/progress$/.exec(path);
  if (progressMatch && method === 'POST') {
    requireWrite(req);
    const titleId = positiveId(progressMatch[1]);
    const input = await body(req);
    const seconds = Number(input.seconds);
    if (!titleExists(titleId) || !Number.isFinite(seconds) || seconds < 0 || seconds > 10_000_000) throw new HttpError(400, 'Invalid playback position.');
    saveProgress(current.user.id, titleId, seconds);
    return send(res, 200, { ok: true });
  }
  const subtitlesMatch=/^\/api\/media\/(\d+)\/subtitles(?:\/(\d+))?$/.exec(path);
  if (subtitlesMatch && method==='GET') {
    const variant=getVariant(positiveId(subtitlesMatch[1]));
    if (!variant || variant.source_type!=='folder') throw new HttpError(404,'Local media not found.');
    const tracks=await localSubtitles(variant);
    if (subtitlesMatch[2]===undefined) return send(res,200,{subtitles:tracks.map((track,index)=>({label:track.label,language:track.language,url:`/api/media/${variant.id}/subtitles/${index}`}))});
    const index=Number(subtitlesMatch[2]);
    if (!Number.isSafeInteger(index) || !tracks[index]) throw new HttpError(404,'Subtitle track not found.');
    const contents=await subtitleVtt(tracks[index]);
    res.writeHead(200,{'Content-Type':'text/vtt; charset=utf-8','Cache-Control':'private, no-store'});
    res.end(contents);
    return;
  }
  const localMatch = /^\/api\/media\/(\d+)\/file$/.exec(path);
  if (localMatch && method === 'GET') return serveLocal(req, res, positiveId(localMatch[1]));
  throw new HttpError(404, 'API endpoint not found.');
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: http: https:; media-src 'self' blob: http: https:; connect-src 'self' http: https:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const name = allowedAssets[url.pathname];
    if (!name || req.method !== 'GET') throw new HttpError(404, 'Page not found.');
    const contents = await readFile(join(webRoot, name));
    res.writeHead(200, { 'Content-Type': contentTypes[extname(name)] || 'application/octet-stream', 'Cache-Control': name === 'sw.js' ? 'no-cache' : 'no-store' });
    res.end(contents);
  } catch (error) {
    const status = error instanceof HttpError || error instanceof ProviderError || error instanceof BackupError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
    if (status === 500) console.error('Request failed:', error);
    const message = status === 500 ? 'The request could not be completed.' : error instanceof Error ? error.message : 'Request failed.';
    if (!res.headersSent) send(res, status, { error: message });
    else res.destroy();
  }
});

const port = Number(process.env.PORT || 9999);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Hearthwave ready on port ${port}`));
const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
