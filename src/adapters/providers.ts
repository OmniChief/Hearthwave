import { providerJson, ProviderError, validateProviderUrl } from './network.ts';
import type { SourceRow } from '../db.ts';
import type { GuideProgramme, ImportItem, ProviderCategory } from '../model.ts';

type Kind = ProviderCategory['kind'];
type Category = { kind: Kind; id: string; name: string };
type Entry = Record<string, unknown>;

function objects(value: unknown): Entry[] {
  const values = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  return values.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as Entry[];
}
function field(value: unknown): string { return value == null ? '' : String(value).trim(); }
function truthy(value: unknown): boolean { return value === true || value === 1 || (typeof value === 'string' && !['','0','false','no'].includes(value.toLowerCase())); }
function yearFrom(value: unknown): number | null {
  const match = /\b(19\d\d|20\d\d)\b/.exec(field(value));
  return match ? Number(match[1]) : null;
}
function quality(name: string): string { return /\b(4K|UHD|FHD|1080P|720P|HD|SD)\b/i.exec(name)?.[1]?.toUpperCase() || ''; }
function artwork(value: unknown): string {
  try { const url = validateProviderUrl(field(value)); return url.toString(); }
  catch { return ''; }
}
function description(value: unknown): string { return field(value).slice(0,4000); }
function genres(value: unknown): string {
  return (Array.isArray(value) ? value.map(field).filter(Boolean).join(', ') : field(value)).slice(0,250);
}
function rating(value: unknown): number | null {
  const n=Number(value);
  return Number.isFinite(n) && n > 0 && n <= 10 ? Math.round(n*10)/10 : null;
}

export function providerKinds(): Kind[] { return ['live','vod','series']; }

function xtreamClient(source: SourceRow) {
  const { username, password, allowLan } = source.config;
  if (!username || !password) throw new ProviderError('Xtream username and password are required.',400);
  const url = validateProviderUrl(source.location.replace(/\/+$/,'').replace(/\/player_api\.php$/i,''));
  if (url.search) throw new ProviderError('Enter the server address without its username and password query.',400);
  const base = url.toString().replace(/\/$/,'');
  return {
    base,
    async action(action: string, params: Record<string,string> = {}): Promise<unknown> {
      const target = new URL(base + '/player_api.php');
      target.search = new URLSearchParams({username,password,...(action?{action}:{}),...params}).toString();
      const response = await providerJson(target.toString(),{allowLan,maxBytes:12*1024*1024});
      const info = (response as {user_info?:{auth?:unknown}})?.user_info;
      if (info && Number(info.auth) !== 1) throw new ProviderError('Xtream provider rejected the account.',502);
      return response;
    },
    url(kind: Kind, streamId: string, extension: string): string {
      const segment = kind === 'vod' ? 'movie' : kind === 'series' ? 'series' : 'live';
      return `${base}/${segment}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.${extension}`;
    },
  };
}

const magAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 MAG250 stbapp ver: 4 rev: 1812 Mobile Safari/533.3';
class StalkerClient {
  endpoint: string;
  token = '';
  private source: SourceRow;
  constructor(source: SourceRow) {
    this.source = source;
    const url = validateProviderUrl(source.location);
    if (url.search) throw new ProviderError('Portal address must not contain a query string.',400);
    const path = url.pathname.replace(/\/$/,'').replace(/\/c$/,'');
    this.endpoint = /\/(?:server\/load|portal)\.php$/.test(path) ? url.origin + path : url.origin + path + '/server/load.php';
  }
  private async request(type: string, action: string, params: Record<string,string | number> = {}, token = '', endpoint = this.endpoint): Promise<Entry> {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({...Object.fromEntries(Object.entries(params).map(([key,value])=>[key,String(value)])),type,action,JsHttpRequest:'1-xml'}).toString();
    const mac = this.source.config.mac || '';
    const response = await providerJson(url.toString(),{
      allowLan:this.source.config.allowLan,maxBytes:8*1024*1024,
      headers:{'User-Agent':magAgent,'X-User-Agent':'Model: MAG250; Link: Ethernet',Cookie:`mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=GMT`,...(token?{Authorization:`Bearer ${token}`}:{})},
    });
    const value = (response as {js?:unknown})?.js;
    if (action === 'do_auth' && typeof value === 'boolean') return {status:value};
    if (!value || typeof value !== 'object') throw new ProviderError('Portal returned an invalid Stalker response.');
    if (Array.isArray(value)) return {data:value};
    if (truthy((value as Entry).error)) throw new ProviderError('Portal rejected the session or requested action.');
    return value as Entry;
  }
  async session(): Promise<void> {
    if (this.token) return;
    const base = this.endpoint.replace(/\/(?:server\/load|portal)\.php$/,'');
    const candidates = [this.endpoint,base+'/portal.php',base+'/server/load.php'];
    let last: unknown;
    for (const endpoint of new Set(candidates)) {
      try {
        const response = await this.request('stb','handshake',{token:''},'',endpoint);
        const token = field(response.token);
        if (!token || /[\r\n]/.test(token)) throw new ProviderError('Portal handshake did not return a token.');
        this.token = token;
        this.endpoint = endpoint;
        break;
      } catch (error) {
        if (error instanceof ProviderError && error.status === 429) throw error;
        last = error;
      }
    }
    if (!this.token) throw last || new ProviderError('Portal handshake failed.');
    const cfg = this.source.config;
    const profile = await this.request('stb','get_profile',{
      hd:1,stb_type:'MAG250',sn:cfg.serial||'',device_id:cfg.deviceId||'',device_id2:cfg.deviceId2||'',
      auth_second_step:1,image_version:218,hw_version:'1.7-BD-00',num_banks:2,client_type:'STB',video_out:'hdmi',
      not_valid_token:0,ver:'ImageDescription: 0.2.18-r14-pub-250; PORTAL version: 5.5.0; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x58c',
    },this.token);
    if (truthy(profile.blocked) || truthy(profile.error)) throw new ProviderError('Portal rejected this registered device.');
    if (cfg.username) {
      const auth = await this.request('stb','do_auth',{login:cfg.username,password:cfg.password||''},this.token);
      if (![true,1,'1'].includes(auth.status as string|number|boolean)) throw new ProviderError('Portal rejected the account login.');
    }
  }
  async call(type: string, action: string, params: Record<string,string | number> = {}): Promise<Entry> {
    await this.session();
    return this.request(type,action,params,this.token);
  }
  async resolve(kind: Kind, cmd: string, series = ''): Promise<string> {
    const params = { cmd,series,forced_storage:'undefined',disable_ad:0,download:0 };
    const type = kind === 'live' ? 'itv' : 'vod';
    let matched: RegExpExecArray | null = null;
    for (const attempt of kind === 'series' ? ['vod','series'] : [type]) {
      try {
        const result = await this.call(attempt,'create_link',params);
        matched = /(?:^|\s)(https?:\/\/[^\s]+)/i.exec(field(result.cmd || result.url));
        if (matched) break;
      } catch (error) {
        if (error instanceof ProviderError && error.status === 429) throw error;
      }
    }
    matched ||= /(?:^|\s)(https?:\/\/[^\s]+)/i.exec(cmd);
    if (!matched) throw new ProviderError('Portal did not provide a playable link.');
    return validateProviderUrl(matched[1]).toString();
  }
}

export async function discoverProvider(source: SourceRow): Promise<Category[]> {
  const discovered: Category[] = [];
  if (source.type === 'xtream') {
    const client = xtreamClient(source);
    await client.action(''); // Check the account before saving category results.
    for (const kind of providerKinds()) {
      const action = kind === 'series' ? 'get_series_categories' : `get_${kind}_categories`;
      const response = await client.action(action);
      for (const row of objects(response)) {
        const id = field(row.category_id);
        if (id && id.length <= 80) discovered.push({kind,id,name:(field(row.category_name) || 'Other').slice(0,160)});
      }
    }
  } else if (source.type === 'stalker') {
    const client = new StalkerClient(source);
    for (const kind of providerKinds()) {
      const response = await client.call(kind === 'live' ? 'itv' : kind,kind === 'live' ? 'get_genres' : 'get_categories');
      for (const row of objects(response.data ?? response)) {
        const id = field(row.id);
        if (id && id.length <= 80) discovered.push({kind,id,name:(field(row.title || row.name) || 'Other').slice(0,160)});
      }
    }
  } else throw new ProviderError('This source does not have provider categories.',400);
  return discovered.slice(0,3000);
}

function xtreamRows(rows: unknown, source: SourceRow, category: ProviderCategory): ImportItem[] {
  const client = xtreamClient(source);
  const items: ImportItem[] = [];
  for (const row of objects(rows)) {
    if (row.category_id != null && field(row.category_id) !== category.category_id) continue;
    const id = field(row.stream_id || row.series_id || row.id);
    if (!/^\d+$/.test(id)) continue;
    const name = field(row.name || row.title);
    if (!name || name.length > 300) continue;
    const kind = category.kind;
    const ext = field(row.container_extension || (kind === 'live' ? 'm3u8' : 'mp4')).replace(/^\./,'').toLowerCase();
    if (!/^[a-z0-9]{2,8}$/.test(ext)) continue;
    items.push({
      kind:kind === 'live' ? 'channel' : kind === 'vod' ? 'film' : 'series', title:name,
      year:yearFrom(row.releaseDate || row.release_date || row.year || name),
      externalId:kind === 'live' ? field(row.epg_channel_id || row.xmltv_id) : '',
      sourceRef:`${kind}:${id}`, url:kind === 'series' ? `xtream-series:${id}` : client.url(kind,id,ext),
      quality:quality(name),group:category.name,artwork:artwork(row.stream_icon || row.cover || row.backdrop_path),
      description:description(row.plot || row.description),genres:genres(row.genre || row.genres),
      rating:rating(row.rating_5based != null ? Number(row.rating_5based)*2 : row.rating_imdb ?? row.rating),
      imdbId:field(row.imdb_id || row.imdb),tmdbId:field(row.tmdb_id),
    });
  }
  return items;
}

function stalkerRows(rows: unknown, category: ProviderCategory): ImportItem[] {
  const items: ImportItem[] = [];
  for (const row of objects(rows)) {
    const categoryValue = field(row.genre_id || row.category_id);
    if (categoryValue && categoryValue !== category.category_id) continue;
    const id = field(row.id);
    const name = field(row.name || row.o_name);
    if (!id || !name || name.length > 300 || id.length > 100) continue;
    const kind = category.kind;
    const cmd = field(row.cmd);
    if (kind !== 'series' && (!cmd || cmd.length > 4096)) continue;
    items.push({kind:kind === 'live' ? 'channel' : kind === 'vod' ? 'film' : 'series',title:name,
      year:yearFrom(row.year || name),externalId:kind === 'live' ? field(row.xmltv_id || row.epg_id) : '',
      sourceRef:`${kind}:${id}`,url:kind === 'series' ? `stalker-series:${id}` : `stalker:${JSON.stringify({kind,cmd})}`,
      quality:quality(name),group:category.name,artwork:artwork(row.logo || row.screenshot_uri),
      description:description(row.description || row.plot),genres:genres(row.genre || row.genres),
      rating:rating(row.rating_imdb ?? row.rating),
      imdbId:field(row.imdb_id || row.imdb),tmdbId:field(row.tmdb_id),
    });
  }
  return items;
}

/** One provider request at a time per source, with global HTTP concurrency bounded to two. */
export async function* importProvider(source: SourceRow, categories: ProviderCategory[]): AsyncGenerator<ImportItem> {
  if (!categories.length) throw new ProviderError('Select at least one provider folder before scanning.',400);
  if (source.type === 'xtream') {
    const client = xtreamClient(source);
    for (const category of categories) {
      const action = category.kind === 'series' ? 'get_series' : `get_${category.kind}_streams`;
      const data = await client.action(action,{category_id:category.category_id});
      for (const item of xtreamRows(data,source,category)) yield item;
    }
  } else if (source.type === 'stalker') {
    const client = new StalkerClient(source);
    for (const category of categories) {
      const type = category.kind === 'live' ? 'itv' : category.kind;
      const params: Record<string,string|number> = category.kind === 'live'
        ? {sortby:'number',genre:category.category_id,search:'',fav:0}
        : {sortby:'name',category:category.category_id,search:''};
      let previousPage = '';
      for (let page = 0; page < 200; page++) {
        const response = await client.call(type,'get_ordered_list',{...params,p:page});
        const rows = objects(response.data);
        if (!rows.length) {
          if (page === 0) continue; // Some portals number their first page 1.
          break;
        }
        const signature = rows.map(row => field(row.id)).join('|');
        if (signature === previousPage) break;
        previousPage = signature;
        for (const item of stalkerRows(rows,category)) yield item;
        const total = Number(response.total_items);
        if (Number.isFinite(total) && total > 0 && (page + 1) * rows.length >= total) break;
      }
    }
  } else throw new ProviderError('This source cannot be scanned with a provider adapter.',400);
}

export async function resolveProviderStream(source: SourceRow, encoded: string): Promise<string> {
  if (source.type !== 'stalker' || !encoded.startsWith('stalker:')) throw new ProviderError('This version is not a Stalker stream.',400);
  let data: {kind:Kind;cmd:string;series?:string};
  try { data = JSON.parse(encoded.slice('stalker:'.length)); }
  catch { throw new ProviderError('Stored provider stream metadata is invalid.'); }
  if (!['live','vod','series'].includes(data.kind) || !data.cmd || (data.series != null && !/^\d{1,4}$/.test(data.series))) throw new ProviderError('Provider stream command is missing or invalid.');
  return new StalkerClient(source).resolve(data.kind,data.cmd,data.series || '');
}

function episodeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 10000 ? number : 0;
}

/** Load an individual show's episodes on demand, not during every category scan. */
export async function discoverSeriesEpisodes(source: SourceRow, encoded: string, seriesTitle: string, year: number | null): Promise<ImportItem[]> {
  const episodes: ImportItem[] = [];
  if (source.type === 'xtream' && /^xtream-series:\d+$/.test(encoded)) {
    const root = encoded.slice('xtream-series:'.length);
    const client = xtreamClient(source);
    const response = await client.action('get_series_info',{series_id:root}) as Entry;
    const groups = response?.episodes;
    if (!groups || typeof groups !== 'object') throw new ProviderError('Xtream did not return episode information for this show.');
    const seen = new Set<string>();
    for (const [seasonKey,raw] of Object.entries(groups)) {
      const rows = objects(raw && typeof raw === 'object' && !Array.isArray(raw) && ('id' in raw || 'stream_id' in raw) ? [raw] : raw);
      for (const row of rows) {
        const id = field(row.id || row.stream_id);
        const season = episodeNumber(row.season ?? seasonKey);
        const episode = episodeNumber(row.episode_num || row.episode);
        const extension = field(row.container_extension || 'mp4').replace(/^\./,'').toLowerCase();
        if (!/^\d+$/.test(id) || !season || !episode || !/^[a-z0-9]{2,8}$/.test(extension) || seen.has(id)) continue;
        seen.add(id);
        episodes.push({kind:'episode',title:seriesTitle,year,season,episode,
          episodeName:field(row.title || row.name),sourceRef:`episode:xtream:${root}:${id}`,
          url:client.url('series',id,extension),group:'Series'});
        if (episodes.length > 1000) throw new ProviderError('This show exceeds the 1,000-episode safety limit.');
      }
    }
  } else if (source.type === 'stalker' && /^stalker-series:[^:]{1,100}$/.test(encoded)) {
    const root = encoded.slice('stalker-series:'.length);
    const client = new StalkerClient(source);
    const queue = [root];
    const visited = new Set<string>();
    const seen = new Set<string>();
    const deadline = Date.now() + 45_000;
    let calls = 0;
    while (queue.length) {
      const parent = queue.shift()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      if (visited.size > 80) throw new ProviderError('Provider series exceeds the folder depth safety limit.');
      let previous = '';
      for (let page = 0; page < 150; page++) {
        if (++calls > 80 || Date.now() > deadline) throw new ProviderError('Episode lookup reached its request/time budget. Try again when the portal is responsive.');
        const response = await client.call('series','get_ordered_list',{sortby:'name',category:'*',search:'',movie_id:parent,p:page});
        const rows = objects(response.data);
        if (!rows.length) { if (page === 0) continue; break; }
        const signature = rows.map(row => field(row.id)).join('|');
        if (signature === previous) break;
        previous = signature;
        for (const row of rows) {
          const id = field(row.id);
          if (!id) continue;
          const cmd = field(row.cmd);
          if (cmd.length > 4096) continue;
          const season = episodeNumber(row.season_number ?? row.season) || episodeNumber(/\bseason\s+(\d+)\b/i.exec(field(row.name))?.[1]);
          const numbers = Array.isArray(row.series) ? row.series : [];
          if (cmd && season && numbers.length) {
            for (const raw of numbers.slice(0,1000)) {
              const episode = episodeNumber(raw);
              const key = `${id}:${episode}`;
              if (!episode || seen.has(key)) continue;
              seen.add(key);
              episodes.push({kind:'episode',title:seriesTitle,year,season,episode,
                episodeName:field(row.episode_title),sourceRef:`episode:stalker:${root}:${key}`,
                url:`stalker:${JSON.stringify({kind:'series',cmd,series:String(episode)})}`,group:'Series'});
            }
          } else if (cmd && season && episodeNumber(row.series_number || row.episode)) {
            const episode = episodeNumber(row.series_number || row.episode);
            const key = `${id}:${episode}`;
            if (!seen.has(key)) {
              seen.add(key);
              episodes.push({kind:'episode',title:seriesTitle,year,season,episode,
                episodeName:field(row.episode_title || row.name),sourceRef:`episode:stalker:${root}:${key}`,
                url:`stalker:${JSON.stringify({kind:'series',cmd,series:String(episode)})}`,group:'Series'});
            }
          } else if (truthy(row.is_series) && !visited.has(id) && !queue.includes(id)) queue.push(id);
          if (episodes.length > 1000) throw new ProviderError('This show exceeds the 1,000-episode safety limit.');
        }
        const total = Number(response.total_items);
        const pageSize = Number(response.max_page_items) || rows.length;
        if (Number.isFinite(total) && total > 0 && (page + 1) * pageSize >= total) break;
      }
    }
  } else throw new ProviderError('This provider series reference is not supported.',400);
  return episodes;
}

function decodeEpg(value: unknown): string {
  const input = field(value);
  if (!input) return '';
  if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(input)) {
    const decoded = Buffer.from(input,'base64').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD') && !/[\x00-\x08]/.test(decoded)) return decoded.slice(0,500);
  }
  return input.slice(0,500);
}

export async function providerGuide(source: SourceRow, sourceRef: string): Promise<GuideProgramme[]> {
  if (!/^live:[^:]{1,100}$/.test(sourceRef)) return [];
  const id = sourceRef.slice('live:'.length);
  let rows: Entry[] = [];
  if (source.type === 'xtream' && /^\d+$/.test(id)) {
    const data = await xtreamClient(source).action('get_short_epg',{stream_id:id,limit:'8'}) as Entry;
    rows = objects(data?.epg_listings);
  } else if (source.type === 'stalker') {
    // Some Stalker portals expose EPG only as a full provider map.
    // Request a single short period, then extract only this channel.
    const data = await new StalkerClient(source).call('itv','get_epg_info',{period:1});
    const guide = data.data ?? data;
    const channel = guide && typeof guide === 'object' ? (guide as Entry)[id] : undefined;
    const matched = channel ?? objects(guide).find(row => field(row.id || row.ch_id || row.channel_id) === id);
    rows = objects(matched && typeof matched === 'object' && !Array.isArray(matched) ? (matched as Entry).data ?? (matched as Entry).events ?? (matched as Entry).epg ?? matched : matched);
  }
  return rows.slice(0,8).map(row => ({
    title:decodeEpg(row.name || row.title) || 'Untitled programme',
    description:decodeEpg(row.descr || row.description),
    start:field(row.start_timestamp || row.start || row.time),
    end:field(row.stop_timestamp || row.end || row.time_to),
  }));
}
