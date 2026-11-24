import { requestsApi } from './requests.ts';
import { roomsApi } from './rooms.ts';
import { jobsApi, workerApi } from './jobs.ts';
import { spaceApi, SpaceError } from './space.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { lookupLocalFilm } from './local-films.ts';
import { startMetadata, metadataStatus, metadataBusy, cancelMetadata } from './maintenance.ts';
import { liveGenres, parseM3u, scanFolder } from './catalogue.ts';
import { gameInfo, gameSystem } from './games.ts';
import { libraryGenres } from './library-genres.ts';
import { qualityPreferences, type QualityPreference } from './quality.ts';
import { BackupError, backupBusy, streamBackup } from './backup.ts';
import { UpdateError, checkForUpdate, startUpdate, updateStatus } from './updater.ts';
import { abortGuideImport, addGuideFeed, addSource, channelGenreCounts, completeImport, countTitles, createCollection, createSmartCollection, createUser, dashboardStats, dataDir, db, deleteCollection, deleteGuideFeed, deleteSource, enrichTitleMetadata, findUser, getGuideFeed, getGuideMapping, getSource, getTitle, getTitleDetail, getUserPreferences, getVariant, guideGrid, hasUsers, importBatch, libraryGenreCounts, listCategories, listCollections, listGuideFeeds, listSeriesEpisodes, listSources, listTitles, listVariants, loadSession, ownedCollection, publicGuideFeed, publicSource, publicUsers, removeGuideMapping, removeSession, renameCollection, replaceSeriesEpisodes, saveCategories, saveGuideMapping, saveProgress, saveSession, searchGuideChannels, selectCategories, setCollectionMembership, setFavourite, setWatchlisted, setGuideStatus, setSourceStatus, setUserPreferences, storedGuide, titleExists, updateSmartCollectionRules, type GuideFeed, type SmartRules, type SourceRow } from './db.ts';
import { discoverProvider, discoverSeriesEpisodes, fetchTitleMetadata, importProvider, providerGuide, resolveProviderStream, type ProviderScanProgress } from './adapters/providers.ts';
import { importXmltv } from './guide.ts';
import { localSubtitles, subtitleVtt } from './subtitles.ts';
import { checkMediaResponse, fetchM3u, ProviderError, validateProviderUrl } from './adapters/network.ts';
import type { GuideProgramme, ImportItem, ProviderCategory, ProviderConfig, SourceType, User } from './model.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const allowedAssets: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/tv-navigation.js': 'tv-navigation.js', '/playback-variants.js': 'playback-variants.js', '/hls-playback.js': 'hls-playback.js', '/playback-diagnostics.js': 'playback-diagnostics.js', '/local-media.js': 'local-media.js', '/space.js': 'space.js', '/workers.js': 'workers.js', '/rooms.js': 'rooms.js', '/requests.js': 'requests.js', '/vendor/hls.light.min.js': 'vendor/hls.light.min.js',
  '/styles.css': 'styles.css', '/manifest.webmanifest': 'manifest.webmanifest',
  '/game.html':'game.html', '/game.js':'game.js',
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
const episodeJobs = new Map<number, {status:'running'|'ready'|'error';started:number;finished:number;error:string;processed:number;total:number;episodes:number}>();
const guideCache = new Map<number, {expires:number;programmes:GuideProgramme[];source:string}>();
const importingGuides = new Set<number>();
const guideJobs=new Map<number,{phase:'running'|'completed'|'error';channels:number;programmes:number;error:string}>();
let providerGuideRefresh:number|null=null;
let systemOperation=false;
const refreshingMetadata=new Set<number>();
const metadataLastAttempt=new Map<number,number>();
function maintenanceActive():boolean {
  return !!(inProgress.size||importingGuides.size||refreshingMetadata.size||providerGuideRefresh!==null||metadataBusy()||[...episodeJobs.values()].some(j=>j.status==='running')||backupBusy()||systemOperation);
}
function requireIdle():void {if(maintenanceActive())throw new HttpError(409,'Another administrator operation is running. Check Settings → Metadata & Guide or Sources for its progress.');}
function activity(){return {busy:maintenanceActive(),sources:Object.fromEntries(sourceJobs),episodes:Object.fromEntries(episodeJobs),guides:Object.fromEntries(guideJobs),metadata:metadataStatus(),titleMetadata:[...refreshingMetadata],providerGuide:providerGuideRefresh,backup:backupBusy(),systemOperation};}

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
function smartRules(value:unknown):SmartRules {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new HttpError(400,'Smart collection rules are required.');
  const input=value as Record<string,unknown>;
  const kind=input.kind??'all',view=input.view??'all',genre=input.genre??'',query=input.query??'';
  if(typeof kind!=='string' || !['all','film','series','episode','music','photo'].includes(kind)) throw new HttpError(400,'Unknown smart collection media type.');
  if(typeof view!=='string' || !['all','favourites','continue','unwatched'].includes(view)) throw new HttpError(400,'Unknown smart collection watching status.');
  if(typeof genre!=='string' || (genre!=='' && !libraryGenres.includes(genre as typeof libraryGenres[number]))) throw new HttpError(400,'Unknown smart collection genre.');
  if(genre && !['all','film','series'].includes(kind)) throw new HttpError(400,'Genre rules apply only to films and series.');
  if(typeof query!=='string' || query.length>80 || /[\p{Cc}\p{Cf}]/u.test(query)) throw new HttpError(400,'Invalid smart collection title filter.');
  const year=(raw:unknown):number|null=> {
    if(raw===null || raw===undefined || raw==='') return null;
    if(typeof raw!=='number' || !Number.isInteger(raw) || raw<1880 || raw>2100) throw new HttpError(400,'Smart collection years must be between 1880 and 2100.');
    return raw;
  };
  const yearFrom=year(input.yearFrom),yearTo=year(input.yearTo);
  if(yearFrom!==null && yearTo!==null && yearFrom>yearTo) throw new HttpError(400,'The first year cannot be after the last year.');
  if(kind==='all' && !genre && view==='all' && yearFrom===null && yearTo===null && !query.trim()) throw new HttpError(400,'Choose at least one smart collection rule.');
  return {kind:kind as SmartRules['kind'],genre,yearFrom,yearTo,view:view as SmartRules['view'],query:query.trim()};
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
  requireIdle();
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
  requireIdle();
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
  requireIdle();
  const current = episodeJobs.get(seriesId);
  if (current?.status === 'running') throw new HttpError(409,'Episodes are already being retrieved.');
  if (current && Date.now() - current.started < 60_000) throw new HttpError(429,'Wait one minute before refreshing this show again.');
  if ([...episodeJobs.values()].filter(job=>job.status === 'running').length >= 3) throw new HttpError(429,'Episode lookups are busy. Please try again shortly.');
  const show = getTitle(seriesId);
  if (!show || show.kind !== 'series') throw new HttpError(404,'Series not found.');
  const variants = listVariants(seriesId).filter(row=>row.url.startsWith('xtream-series:') || row.url.startsWith('stalker-series:')).slice(0,8);
  if (!variants.length) throw new HttpError(404,'This series has no supported provider connection.');
  const job={status:'running' as 'running'|'ready'|'error',started:Date.now(),finished:0,error:'',processed:0,total:variants.length,episodes:0};
  episodeJobs.set(seriesId,job);
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
      if (!source) {job.processed+=sourceVariants.length;continue;}
      try {
        const collected: ImportItem[] = [];
        for (const variant of sourceVariants) {const found=await discoverSeriesEpisodes(source,variant.url,show.title,show.year);collected.push(...found);job.episodes+=found.length;}
        if (!collected.length) throw new ProviderError('Provider returned no playable episodes; existing episodes were kept.');
        replaceSeriesEpisodes(seriesId,sourceId,collected);
        successful++;
      } catch (error) {
        errors.push(`${source.name}: ${error instanceof Error ? error.message.slice(0,180) : 'Could not load episodes.'}`);
      } finally {job.processed+=sourceVariants.length;}
    }
    Object.assign(job,{status:successful?'ready':'error',finished:Date.now(),error:errors.join(' · ').slice(0,350)});
  })();
}

function startGuideImport(feed:GuideFeed):void {
  requireIdle();
  if (importingGuides.has(feed.id)) throw new HttpError(409,'This guide is already importing.');
  if (importingGuides.size>=1) throw new HttpError(429,'Only one guide can import at a time on a low-memory server.');
  const address=new URL(feed.location);
  const previous=feed.last_import ? Date.parse(feed.last_import.replace(' ','T')+'Z') : NaN;
  if (/(?:^|\.)open-epg\.com$/i.test(address.hostname) && Number.isFinite(previous) && Date.now()-previous<6*3600_000)
    throw new HttpError(429,'Open-EPG only updates daily. Wait at least six hours between successful imports of this feed.');
  importingGuides.add(feed.id);
  if(guideJobs.size>=100)guideJobs.delete(guideJobs.keys().next().value!);
  const job={phase:'running' as 'running'|'completed'|'error',channels:0,programmes:0,error:''};guideJobs.set(feed.id,job);
  setGuideStatus(feed.id,'importing');
  const generation=randomUUID();
  void (async()=>{
    try {
      const result=await importXmltv(feed,generation,(channels,programmes)=>Object.assign(job,{channels,programmes}));
      job.phase='completed';guideCache.clear();
      console.log(`Guide ${feed.id} imported: ${result.channels} channels, ${result.programmes} programmes`);
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Guide import failed.';
      job.phase='error';job.error=message.slice(0,250);
      abortGuideImport(feed.id,generation,message);
      console.error(`Guide ${feed.id} import failed:`,message);
    } finally { importingGuides.delete(feed.id); }
  })();
}

async function* playlistItems(address:string):AsyncGenerator<ImportItem> {
  const items = parseM3u(await fetchM3u(address));
  if (!items.length) throw new Error('The playlist contains no HTTP or HTTPS channels.');
  yield* items;
}

async function* arrayItems(items: ImportItem[]): AsyncGenerator<ImportItem> {
  for (const item of items) yield item;
}

async function cueTracks(file:string):Promise<string[]> {
  if(extname(file).toLowerCase()!=='.cue') return [];
  if((await stat(file)).size>1024*1024) throw new HttpError(400,'Cue sheet is too large.');
  const cue=await readFile(file,'utf8');
  return [...new Set(Array.from(cue.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+BINARY\s*$/gmi),m=>m[1] || m[2]))]
    .filter(name=>!/[\\/]/.test(name) && /\.bin$/i.test(name));
}

async function serveLocal(req: IncomingMessage, res: ServerResponse, variantId: number, gameFile?:string): Promise<void> {
  const variant = getVariant(variantId);
  if (!variant || variant.source_type !== 'folder') throw new HttpError(404, 'Local media not found.');
  const root = await realpath(variant.source_location);
  let file = await realpath(variant.url);
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HttpError(403, 'The media file is outside its configured folder.');
  if(gameFile!==undefined) {
    if(getTitle(variant.title_id)?.kind!=='game') throw new HttpError(404,'Game not found.');
    if(gameFile!==basename(file)) {
      if(!(await cueTracks(file)).includes(gameFile)) throw new HttpError(404,'Disc track not found.');
      const track=await realpath(join(dirname(file),gameFile));
      if(dirname(track)!==dirname(file)) throw new HttpError(403,'Disc track is outside its game folder.');
      file=track;
    }
  }
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
  if (gameFile===undefined && getTitle(variant.title_id)?.kind === 'game') {
    headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(basename(file)).replace(/'/g,'%27');
  }
  res.writeHead(range ? 206 : 200, headers);
  const stream = createReadStream(file, { start, end });
  stream.on('error', error => { console.error('Local playback failed:', error); res.destroy(error); });
  stream.pipe(res);
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  const method = req.method || 'GET';
  if (path === '/api/health' && method === 'GET') return send(res, 200, { ok: true, name: 'Hearthwave', version: '0.28.0', pid: process.pid });
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

  if(path.startsWith('/api/worker/')) return workerApi(req,res,url,body,send);
  const current = requireUser(req);
  if(path==='/api/requests'||path.startsWith('/api/requests/')) {
    if(method!=='GET') requireWrite(req);
    return requestsApi(req,res,url,current.user,body,send);
  }
  if(path==='/api/jobs'||path.startsWith('/api/jobs/')) {
    if(method!=='GET') requireWrite(req);
    return jobsApi(req,res,url,current.user,body,send);
  }
  if(path==='/api/community/rooms'||path.startsWith('/api/community/rooms/')) {
    if(method!=='GET') requireWrite(req);
    return roomsApi(req,res,url,current.user,body,send);
  }
  if(path.startsWith('/api/space/') || path.startsWith('/api/community/')) {
    if(method!=='GET') requireWrite(req);
    return spaceApi(req,res,url,current.user,body,send);
  }
  if(path==='/api/system/activity'&&method==='GET'){
    if(current.user.role!=='admin')throw new HttpError(403,'Administrator access required.');
    return send(res,200,activity());
  }
  if(path==='/api/system/metadata'&&method==='POST'){
    requireWrite(req,true);const input=await body(req);requireIdle();
    if(input.kind!=='film'&&input.kind!=='game')throw new HttpError(400,'Choose films or games.');
    if(input.retry!==undefined&&typeof input.retry!=='boolean')throw new HttpError(400,'Invalid retry setting.');
    return send(res,202,{job:startMetadata(input.kind,input.retry===true)});
  }
  if(path==='/api/system/metadata/cancel'&&method==='POST'){
    requireWrite(req,true);if(!metadataBusy())throw new HttpError(409,'No metadata job is active.');cancelMetadata();return send(res,202,{job:metadataStatus()});
  }
  if (path === '/api/system/status' && method === 'GET') {
    if (current.user.role !== 'admin') throw new HttpError(403, 'Administrator access required.');
    const databaseInfo = await stat(join(dataDir, 'hearthwave.sqlite'));
    return send(res, 200, { version: '0.28.0', schema: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, databaseBytes: databaseInfo.size, rssBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(process.uptime()), backupBusy: backupBusy() });
  }
  if(path==='/api/system/update/check' && method==='GET') {
    if(current.user.role!=='admin') throw new HttpError(403,'Administrator access required.');
    return send(res,200,await checkForUpdate(true));
  }
  if(path==='/api/system/update/status' && method==='GET') {
    if(current.user.role!=='admin') throw new HttpError(403,'Administrator access required.');
    return send(res,200,await updateStatus());
  }
  if(path==='/api/system/update/install' && method==='POST') {
    requireWrite(req,true);
    const input=await body(req);
    if(typeof input.sha!=='string' || !/^[a-f0-9]{40}$/.test(input.sha)) throw new HttpError(400,'Choose a verified GitHub commit first.');
    requireIdle();systemOperation=true;
    try{await startUpdate(input.sha,shutdownForUpdate);}catch(error){systemOperation=false;throw error;}
    return send(res,202,{accepted:true,message:'Preparing the verified update. Hearthwave will restart when ready.'});
  }
  if (path === '/api/system/backup' && method === 'POST') {
    requireWrite(req, true);
    requireIdle();systemOperation=true;
    try{if((await updateStatus()).busy)throw new HttpError(409,'Wait for the active update to finish before exporting the database.');return await streamBackup(res);}finally{systemOperation=false;}
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
  if (path === '/api/collections') {
    if(method==='GET') {
      const titleId=url.searchParams.has('titleId')?positiveId(url.searchParams.get('titleId')!):0;
      return send(res,200,{collections:listCollections(current.user.id,titleId),genres:libraryGenres});
    }
    if(method==='POST') {
      requireWrite(req);
      const input=await body(req);
      const name=textField(input.name,'collection name',70);
      if(/[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400,'Collection names cannot include control characters.');
      const mode=input.mode??'manual';
      if(mode!=='manual' && mode!=='smart') throw new HttpError(400,'Unknown collection type.');
      const rules=mode==='smart'?smartRules(input.rules):null;
      try {return send(res,201,{id:rules?createSmartCollection(current.user.id,name,rules):createCollection(current.user.id,name),name,mode});}
      catch(error) {
        if(error instanceof Error && /UNIQUE constraint|up to 64 collections/i.test(error.message)) throw new HttpError(409,'A collection with that name already exists, or your collection limit has been reached.');
        throw error;
      }
    }
  }
  const rulesMatch=/^\/api\/collections\/(\d+)\/rules$/.exec(path);
  if(rulesMatch && method==='PATCH') {
    requireWrite(req);
    const id=positiveId(rulesMatch[1]);
    const collection=ownedCollection(current.user.id,id);
    if(!collection) throw new HttpError(404,'Collection not found.');
    if(collection.mode!=='smart') throw new HttpError(409,'Manual collections do not have automatic rules.');
    const input=await body(req);
    updateSmartCollectionRules(current.user.id,id,smartRules(input.rules));
    return send(res,200,{updated:true});
  }
  const collectionMatch=/^\/api\/collections\/(\d+)(?:\/items(?:\/(\d+))?)?$/.exec(path);
  if(collectionMatch) {
    const id=positiveId(collectionMatch[1]);
    const collection=ownedCollection(current.user.id,id);
    if(!collection) throw new HttpError(404,'Collection not found.');
    if(method==='PATCH' && collectionMatch[2]===undefined && !path.endsWith('/items')) {
      requireWrite(req);
      const input=await body(req);
      const name=textField(input.name,'collection name',70);
      if(/[\p{Cc}\p{Cf}]/u.test(name)) throw new HttpError(400,'Collection names cannot include control characters.');
      try {renameCollection(current.user.id,id,name);return send(res,200,{id,name});}
      catch(error) {
        if(error instanceof Error && /UNIQUE constraint/i.test(error.message)) throw new HttpError(409,'You already have a collection with that name.');
        throw error;
      }
    }
    if(method==='DELETE' && collectionMatch[2]===undefined && !path.endsWith('/items')) {
      requireWrite(req);
      deleteCollection(current.user.id,id);
      return send(res,200,{deleted:true});
    }
    if(method==='POST' && path.endsWith('/items')) {
      requireWrite(req);
      if(collection.mode==='smart') throw new HttpError(409,'Smart collections are populated automatically from their rules.');
      const input=await body(req);
      const titleId=positiveId(String(input.titleId));
      try {
        if(!setCollectionMembership(current.user.id,id,titleId,true)) throw new HttpError(404,'Library title not found.');
      } catch(error) {
        if(error instanceof Error && /limited to 2,000 items/i.test(error.message)) throw new HttpError(409,error.message);
        throw error;
      }
      return send(res,200,{included:true});
    }
    if(method==='DELETE' && collectionMatch[2]!==undefined) {
      requireWrite(req);
      if(collection.mode==='smart') throw new HttpError(409,'Smart collections are populated automatically from their rules.');
      const titleId=positiveId(collectionMatch[2]);
      if(!setCollectionMembership(current.user.id,id,titleId,false)) throw new HttpError(404,'Library title not found.');
      return send(res,200,{included:false});
    }
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
      if (source.type === 'm3u' && source.location) startImport(source, playlistItems(source.location));
      else if (source.type === 'folder') startImport(source, scanFolder(source.location, source.name));
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
    return send(res,200,{feeds:listGuideFeeds().map(feed=>({...publicGuideFeed(feed),job:guideJobs.get(feed.id)||null}))});
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
    if (!['all', 'library', 'film', 'series', 'episode', 'channel', 'music', 'photo', 'game'].includes(kind)) throw new HttpError(400, 'Unsupported media kind.');
    const query = (url.searchParams.get('q') || '').slice(0, 120);
    const view=url.searchParams.get('view') || 'all';
    const sort=url.searchParams.get('sort') || 'title';
    if(!['all','favourites','continue','watchlist'].includes(view) || !['title','year','added','activity'].includes(sort)) throw new HttpError(400,'Unknown Library filter or sort order.');
    const limit=Math.min(250,Math.max(1,Math.floor(Number(url.searchParams.get('limit') || 250) || 250)));
    const offset=Number(url.searchParams.get('offset') || 0);
    if(!Number.isSafeInteger(offset) || offset<0 || offset>1_000_000) throw new HttpError(400,'Invalid catalogue page.');
    const country=url.searchParams.get('country') || '';
    const genre=url.searchParams.get('genre') || '';
    const collectionId=url.searchParams.has('collection')?positiveId(url.searchParams.get('collection')!):0;
    const collection=collectionId?ownedCollection(current.user.id,collectionId):undefined;
    if(collectionId && (!collection || kind==='channel')) throw new HttpError(404,'Collection not found.');
    if (country && kind!=='channel') throw new HttpError(400,'Country filters apply only to Live channels.');
    if (!['','GB','US','other'].includes(country)) throw new HttpError(400,'Unknown Live country filter.');
    if (genre && (kind==='channel' ? !liveGenres.includes(genre as typeof liveGenres[number]) : !['library','film','series'].includes(kind) || !libraryGenres.includes(genre as typeof libraryGenres[number]))) throw new HttpError(400,'Unknown genre filter for this catalogue.');
    const typedKind=kind as 'all'|'library'|ImportItem['kind'];
    const typedView=view as 'all'|'favourites'|'continue'|'watchlist',typedSort=sort as 'title'|'year'|'added'|'activity';
    const liveGenre=kind==='channel'?genre:'',libraryGenre=kind==='channel'?'':genre;
    const rows=listTitles(typedKind,current.user.id,query,typedView,typedSort,limit,offset,country,liveGenre,libraryGenre,collection) as Array<Record<string,unknown> & {game_path?:string}>;
    const items=rows.map(({game_path,...row})=>{
      if(!game_path)return row;
      const info=gameInfo(game_path);
      return {...row,core:info.core,system:info.system};
    });
    return send(res,200,{
      items,
      total:countTitles(typedKind,current.user.id,query,typedView,country,liveGenre,libraryGenre,collection),
      offset,limit,maxResults:limit,
      genres:collectionId?[]:kind==='channel'?channelGenreCounts(country,query,current.user.id,typedView):['library','film','series'].includes(kind)?libraryGenreCounts(kind as 'library'|'film'|'series',current.user.id,query,typedView):[],
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
    requireIdle();refreshingMetadata.add(titleId);
    try {
      const seen=new Set<number>();
      const variants=listVariants(titleId).filter(v=>{
        if(!['xtream','stalker'].includes(v.source_type) || !/^(vod|series):/.test(v.source_ref) || seen.has(v.source_id)) return false;
        seen.add(v.source_id);return true;
      }).slice(0,3);

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
      const film = getTitle(titleId);
      if (!updated && film?.kind === 'film' && listVariants(titleId).some(v => v.source_type === 'folder')) {
        try {
          const info = await lookupLocalFilm(film.title, film.year);
          if (info && enrichTitleMetadata(titleId, info)) updated++;
        } catch { failures.push(new Error('Movie lookup unavailable.')); }
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
      requireWrite(req,true);
      startEpisodeDiscovery(titleId);
      return send(res,202,{status:'running'});
    }
  }
  const guideMatch = /^\/api\/titles\/(\d+)\/guide$/.exec(path);
  if (guideMatch && (method === 'GET'||method==='POST')) {
    const titleId = positiveId(guideMatch[1]);
    if (getTitle(titleId)?.kind !== 'channel') throw new HttpError(404,'Live channel not found.');
    const xmltv=storedGuide(titleId);
    if(method==='GET'){
      if(xmltv.programmes.length)return send(res,200,{...xmltv,cached:true,kind:'xmltv'});
      const cached=guideCache.get(titleId);
      return send(res,200,cached&&cached.expires>Date.now()?{programmes:cached.programmes,source:cached.source,cached:true}:{...xmltv,cached:true,kind:'xmltv'});
    }
    requireWrite(req,true);requireIdle();providerGuideRefresh=titleId;
    try{
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
    guideCache.set(titleId,{expires:Date.now()+6*3600_000,programmes,source:sourceName});
    if (guideCache.size > 100) guideCache.delete(guideCache.keys().next().value!);
    return send(res,200,{programmes,source:sourceName,cached:false});
    }finally{providerGuideRefresh=null;}
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
  const resolveMatch = /^\/api\/variants\/(\d+)\/(resolve|check-playback)$/.exec(path);
  if (resolveMatch && method === 'POST') {
    requireWrite(req);
    const variant = getVariant(positiveId(resolveMatch[1]));
    if (!variant) throw new HttpError(404,'Source version not found.');
    const source = getSource(variant.source_id);
    if (!source) throw new HttpError(404,'Source connection not found.');
    const stream = await resolveProviderStream(source,variant.url);
    if (resolveMatch[2] === 'check-playback') {
      const message = await checkMediaResponse(stream, Boolean(source.config.allowLan));
      return send(res,200,{message});
    }
    return send(res,200,{url:stream});
  }
  const watchlistMatch=/^\/api\/titles\/(\d+)\/watchlist$/.exec(path);
  if(watchlistMatch&&method==='POST'){
    requireWrite(req);
    const id=positiveId(watchlistMatch[1]),title=getTitle(id),input=await body(req);
    if(!title||!['film','series','episode'].includes(title.kind))throw new HttpError(404,'Choose a film, series or episode.');
    if(typeof input.include!=='boolean')throw new HttpError(400,'Expected a watchlist boolean.');
    setWatchlisted(current.user.id,id,input.include);
    return send(res,200,{watchlisted:input.include});
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
  const gameRoute=/^\/api\/games\/(\d+)(?:\/rom\/([^/]+))?$/.exec(path);
  if(gameRoute && method==='GET') {
    const id=positiveId(gameRoute[1]);
    if(gameRoute[2]) return serveLocal(req,res,id,decodeURIComponent(gameRoute[2]));
    const v=getVariant(id);
    if(!v || v.source_type!=='folder' || getTitle(v.title_id)?.kind!=='game') throw new HttpError(404,'Game not found.');
    const root=await realpath(v.source_location), file=await realpath(v.url);
    const rel=relative(root,file);
    if(!rel || rel==='..' || rel.startsWith('..'+sep) || isAbsolute(rel)) throw new HttpError(403,'Game outside its source.');
    const tracks=await cueTracks(file);
    const romUrl=(name:string)=>'/api/games/'+id+'/rom/'+encodeURIComponent(name);
    return send(res,200,{core:gameSystem(v.url)?.core,filename:basename(file),url:romUrl(basename(file)),
      tracks:Object.fromEntries(tracks.map(name=>['/'+name,romUrl(name)]))});
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
    if(url.pathname==='/game.html') {
      res.setHeader('X-Frame-Options','SAMEORIGIN');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-eval' blob: https://cdn.emulatorjs.org; style-src 'self' 'unsafe-inline' https://cdn.emulatorjs.org; connect-src 'self' blob: data: https://cdn.emulatorjs.org; img-src 'self' blob: data: https://cdn.emulatorjs.org; font-src data: https://cdn.emulatorjs.org; worker-src 'self' blob:; media-src blob: data:; frame-ancestors 'self'; object-src 'none'");
    }
    const name = allowedAssets[url.pathname];
    if (!name || req.method !== 'GET') throw new HttpError(404, 'Page not found.');
    const contents = await readFile(join(webRoot, name));
    res.writeHead(200, { 'Content-Type': contentTypes[extname(name)] || 'application/octet-stream', 'Cache-Control': name === 'sw.js' ? 'no-cache' : 'no-store' });
    res.end(contents);
  } catch (error) {
    const status = error instanceof SpaceError || error instanceof HttpError || error instanceof ProviderError || error instanceof BackupError || error instanceof UpdateError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
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
const shutdownForUpdate = () => {
  shutdown();
  // Active local-media responses may outlive the restart request: close them after a short grace period.
  setTimeout(()=>server.closeAllConnections(),4000).unref();
  setTimeout(()=>process.exit(1),15000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
