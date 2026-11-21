import { providerJson, ProviderError, validateProviderUrl } from './network.ts';
import type { SourceRow } from '../db.ts';
import type { ImportItem, ProviderCategory } from '../model.ts';

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
  async resolve(kind: Kind, cmd: string): Promise<string> {
    const result = await this.call(kind === 'live' ? 'itv' : 'vod','create_link',{
      cmd,forced_storage:'undefined',disable_ad:0,download:0,
    });
    const value = field(result.cmd || result.url);
    const matched = /(?:^|\s)(https?:\/\/[^\s]+)/i.exec(value);
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
        if (id) discovered.push({kind,id,name:field(row.category_name) || 'Other'});
      }
    }
  } else if (source.type === 'stalker') {
    const client = new StalkerClient(source);
    for (const kind of providerKinds()) {
      const response = await client.call(kind === 'live' ? 'itv' : kind,kind === 'live' ? 'get_genres' : 'get_categories');
      for (const row of objects(response.data ?? response)) {
        const id = field(row.id);
        if (id) discovered.push({kind,id,name:field(row.title || row.name) || 'Other'});
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
    if (!name) continue;
    const kind = category.kind;
    const ext = field(row.container_extension || (kind === 'live' ? 'm3u8' : 'mp4')).replace(/^\./,'').toLowerCase();
    if (!/^[a-z0-9]{2,8}$/.test(ext)) continue;
    items.push({
      kind:kind === 'live' ? 'channel' : kind === 'vod' ? 'film' : 'series', title:name,
      year:yearFrom(row.releaseDate || row.release_date || name),
      externalId:kind === 'live' ? field(row.epg_channel_id || row.xmltv_id) : '',
      sourceRef:`${kind}:${id}`, url:kind === 'series' ? `xtream-series:${id}` : client.url(kind,id,ext),
      quality:quality(name),group:category.name,artwork:artwork(row.stream_icon || row.cover || row.backdrop_path),
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
    if (!id || !name) continue;
    const kind = category.kind;
    const cmd = field(row.cmd);
    if (kind !== 'series' && !cmd) continue;
    items.push({kind:kind === 'live' ? 'channel' : kind === 'vod' ? 'film' : 'series',title:name,
      year:yearFrom(row.year || name),externalId:kind === 'live' ? field(row.xmltv_id || row.epg_id) : '',
      sourceRef:`${kind}:${id}`,url:kind === 'series' ? `stalker-series:${id}` : `stalker:${JSON.stringify({kind,cmd})}`,
      quality:quality(name),group:category.name,artwork:artwork(row.logo || row.screenshot_uri),
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
  let data: {kind:Kind;cmd:string};
  try { data = JSON.parse(encoded.slice('stalker:'.length)); }
  catch { throw new ProviderError('Stored provider stream metadata is invalid.'); }
  if (!['live','vod'].includes(data.kind) || !data.cmd) throw new ProviderError('Provider stream command is missing.');
  return new StalkerClient(source).resolve(data.kind,data.cmd);
}
