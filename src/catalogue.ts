import { basename, extname, join } from 'node:path';
import { gameSystem, isCartridgeBin } from './games.ts';
import { opendir } from 'node:fs/promises';
import type { ImportItem } from './model.ts';

const MEDIA_EXTS = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.mp3', '.flac', '.m4a', '.wav', '.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm']);
const MUSIC_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav']);

export function cleanTitle(raw: string): string {
  return raw.replace(/\.(?:mp4|m4v|mkv|avi|mov|webm|mp3|flac|m4a|wav|jpg|jpeg|png|webp)$/i, '').replace(/[._]+/g, ' ').replace(/\s*(?:\[(?:4K|2160P|1080P|720P|UHD|FHD|HEVC|HD|SD)\]|\((?:4K|2160P|1080P|720P|UHD|FHD|HEVC|HD|SD)\))\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function displayLibraryTitle(raw:string):string {
  const name=cleanTitle(raw)
    .replace(/^(?:(?:UK|US|USA|EN|ENGLISH)\s*[-:|]\s*)+/i,'')
    .replace(/^(?:(?:NF|NETFLIX|DISNEY\+|AMAZON|APPLE TV\+)\s*[-:|]\s*)+/i,'')
    .replace(/\s+(?:4K|UHD|FHD|1080P|720P|HEVC|H265|H264|HD|SD)$/i,'')
    .replace(/(?:\s*\[|\s*\(|\s+)(?:19\d{2}|20\d{2})[\])]?$/i,'').trim();
  return name || cleanTitle(raw);
}

/** Stable title identity across provider prefixes, quality labels and optional release-year suffixes. */
export function libraryMatchKey(raw: string): string {
  return displayLibraryTitle(raw).normalize('NFKC').toLowerCase().replace(/&/g,' and ')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim().slice(0,300);
}

const channelQualities = /(?:[\s|:/-]+|^)(?:4K|UHD|FHD|FULL\s*HD|HD|SD|HEVC|H265|H264|1080P|720P|2160P)\s*$/i;
export function displayChannelTitle(raw: string): string {
  let name = raw.trim().replace(/^(?:(?:\[(?:UK|GB|US|USA|EN|ENGLISH|CA|CANADA)\]|(?:UK|GB|US|USA|EN|ENGLISH|CA|CANADA))\s*[-:|]\s*)+/i,'');
  name = name.replace(/\s*\[(?:4K|UHD|FHD|HD|SD|HEVC|1080P|720P|2160P)\]\s*$/i,'').trim();
  for (let i = 0; i < 3; i++) name = name.replace(channelQualities,'').trim();
  return name.replace(/\s+/g,' ').trim() || raw.trim();
}

export function channelKey(name: string): string {
  return displayChannelTitle(name).normalize('NFKC').toLowerCase().replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

export function channelCountry(title: string, group = '', hint = ''): string {
  const normalize = (text: string): string => {
    const value = text.toUpperCase().trim();
    if (/^(?:GB|UK|EN|ENGLISH|UNITED KINGDOM)$/.test(value)) return 'GB';
    if (/^(?:US|USA|UNITED STATES)$/.test(value)) return 'US';
    if (/^(?:CA|CANADA)$/.test(value)) return 'CA';
    return '';
  };
  const explicit = normalize(hint);
  if (explicit) return explicit;
  const prefix = /^\s*(?:\[(UK|GB|US|USA|EN|ENGLISH|CA|CANADA)\]\s*|\|?(UK|GB|US|USA|EN|ENGLISH|CA|CANADA)\s*[-:|])/i.exec(title);
  const pref=prefix?.[1]||prefix?.[2];
  if (pref) return normalize(pref);
  const category = /^(?:\W*)(UK|GB|US|USA|EN|ENGLISH|CA|CANADA)(?:\W|$)/i.exec(group)?.[1];
  return normalize(category || '');
}

export const liveGenres = ['General','Entertainment','Sports','Movies','News','Kids','Documentary','Music','Other'] as const;
export function channelGenre(title:string,group=''):typeof liveGenres[number] {
  const text=`${group} ${title}`.toUpperCase();
  if (/\b(?:SPORTS?|ESPN|DAZN|PPV|EUROSPORT)\b/.test(text)) return 'Sports';
  if (/\b(?:NEWS|CURRENT AFFAIRS)\b/.test(text)) return 'News';
  if (/\b(?:MOVIES?|CINEMA|FILMS?)\b/.test(text)) return 'Movies';
  if (/\b(?:KIDS?|CHILDREN|CARTOON)\b/.test(text)) return 'Kids';
  if (/\b(?:DOCUMENTAR(?:Y|IES)|DOCU|DISCOVERY)\b/.test(text)) return 'Documentary';
  if (/\b(?:MUSIC|RADIO)\b/.test(text)) return 'Music';
  if (/\b(?:ENTERTAINMENT|24\/7)\b/.test(group.toUpperCase())) return 'Entertainment';
  if (/\b(?:GENERAL|FREEVIEW|TERRESTRIAL)\b/.test(group.toUpperCase())) return 'General';
  return 'Other';
}

export function canonicalKey(item: ImportItem): string {
  const region = item.kind === 'channel' ? channelCountry(item.title,item.group,item.region).toLowerCase() : (item.region || '').trim().toLowerCase();
  if (item.kind === 'channel') {
    if (item.externalId?.trim()) return `channel:${region}:epg:${item.externalId.trim().toLowerCase()}`;
    return `channel:${region}:${channelKey(item.title)}:0`;
  }
  const name = cleanTitle(item.title).replace(/^(?:uk|us|usa|en)\s*[-:|]\s*/i, '').replace(/\s+(?:UHD|FHD|4K|HD|SD|1080P|720P)$/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (item.kind === 'game') return JSON.stringify(['game', item.sourceRef]);
  const episode = item.kind === 'episode' ? `:${item.season || 0}:${item.episode || 0}` : '';
  return `${item.kind}:${region}:${name}:${item.year || 0}${episode}`;
}

export function parseM3u(content: string): ImportItem[] {
  if (!content.trimStart().startsWith('#EXTM3U')) throw new Error('The playlist must begin with #EXTM3U.');
  const items: ImportItem[] = [];
  let meta: { title: string; attrs: Record<string, string> } | null = null;
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith('#EXTINF:')) {
      // A comma inside a quoted EXTINF attribute is not the title delimiter.
      let comma=-1,quote='';
      for(let k=8;k<text.length;k++){const c=text[k];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c===','){comma=k;break;}}
      if (comma < 0) { meta = null; continue; }
      const attrs: Record<string, string> = {};
      for (const match of text.slice(0, comma).matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g)) attrs[match[1].toLowerCase()] = match[2]??match[3]??match[4]??'';
      meta = { title: text.slice(comma + 1).trim() || attrs['tvg-name'] || 'Untitled channel', attrs };
    } else if (meta && text && !text.startsWith('#')) {
      try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        const region = channelCountry(meta.title,meta.attrs['group-title']||'',meta.attrs['tvg-country']||'') || channelCountry('', '', (meta.attrs['tvg-id']||'').match(/[._-](uk|gb|us|usa|ca)$/i)?.[1]||'');
        const quality = /\b(4K|UHD|FHD|1080P|720P|HD|SD)\b/i.exec(meta.title)?.[1]?.toUpperCase() || '';
        items.push({ kind: 'channel', title: meta.title, externalId: meta.attrs['tvg-id'], channelAlias:meta.attrs['tvg-name'], sourceRef: String(items.length), url: text, quality, group: meta.attrs['group-title'] || '', region, artwork: meta.attrs['tvg-logo'] || '' });
        if (items.length > 25000) throw new Error('Playlist exceeds the 25,000-channel safety limit.');
      } catch (error) { if (error instanceof Error && error.message.includes('25,000')) throw error; }
      meta = null;
    }
  }
  return items;
}

const romFormats = new Set('.nes .fds .sfc .smc .gb .gbc .gba .nds .3ds .z64 .n64 .v64 .sms .gg .mdx .gen .smd .32x .a26 .a78 .lnx .pce .ngp .ngc .ws .wsc .chd .cso .rvz .wbfs .gcm .xci .nsp .pbp'.split(' '));
const gameFolder = /(?:^|[^a-z0-9])(?:roms?|games?|arcade|mame|fbneo|nes|snes|megadrive|genesis|ps[1-3xp]|playstation|dreamcast|saturn|wii|gamecube|nintendo|amiga)(?:$|[^a-z0-9])/i;

export async function* scanFolder(root: string, sourceName = ''): AsyncGenerator<ImportItem> {
  const pending: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let examined = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const dir = await opendir(current.path);
    for await (const entry of dir) {
      if (++examined > 50000) throw new Error('Folder scan reached the 50,000-entry safety limit.');
      if (entry.isSymbolicLink()) continue;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 9) pending.push({ path, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      const inGameFolder = gameFolder.test(current.path) || gameFolder.test(sourceName);
      if (isCartridgeBin(path) || romFormats.has(extension) || (gameSystem(path)?.formats.includes(extension)) || ((inGameFolder || gameSystem(path)) && ['.zip','.7z','.iso','.cue','.md','.d64','.adf'].includes(extension))) {
        const title = basename(entry.name, extname(entry.name)).replace(/[._]+/g, ' ').trim();
        yield {kind:'game', title, group:basename(current.path), sourceRef:path, url:path};
        continue;
      }
      if (!MEDIA_EXTS.has(extension)) continue;
      const name = cleanTitle(basename(entry.name));
      const year = /(?:^|\s|\()(19\d{2}|20\d{2})(?:\)|\s|$)/.exec(name)?.[1];
      const series = /\bS(\d{1,2})E(\d{1,3})\b/i.exec(name);
      const title = series ? name.slice(0, series.index).trim() : name.replace(/\s*\(?(?:19\d{2}|20\d{2})\)?\s*$/, '').trim();
      const kind = MUSIC_EXTS.has(extension) ? 'music' : VIDEO_EXTS.has(extension) ? (series ? 'episode' : 'film') : 'photo';
      yield { kind, title: title || name, year: year ? Number(year) : null, season: series ? Number(series[1]) : null, episode: series ? Number(series[2]) : null, sourceRef: path, url: path, group: kind === 'episode' ? 'Series' : kind === 'film' ? 'Films' : kind === 'music' ? 'Music' : 'Photos' };
    }
  }
}
