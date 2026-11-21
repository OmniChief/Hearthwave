import { basename, extname, join } from 'node:path';
import { opendir } from 'node:fs/promises';
import type { ImportItem } from './model.ts';

const MEDIA_EXTS = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm', '.mp3', '.flac', '.m4a', '.wav', '.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mkv', '.avi', '.mov', '.webm']);
const MUSIC_EXTS = new Set(['.mp3', '.flac', '.m4a', '.wav']);

export function cleanTitle(raw: string): string {
  return raw.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s*(?:\[(?:4K|2160P|1080P|720P|UHD|FHD|HEVC|HD|SD)\]|\((?:4K|2160P|1080P|720P|UHD|FHD|HEVC|HD|SD)\))\s*/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function canonicalKey(item: ImportItem): string {
  const region = (item.region || '').trim().toLowerCase();
  const name = cleanTitle(item.title).replace(/^(?:uk|us|usa|en)\s*[-:|]\s*/i, '').replace(/\s+(?:UHD|FHD|4K|HD|SD|1080P|720P)$/i, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (item.kind === 'channel' && item.externalId?.trim()) return `channel:${region}:epg:${item.externalId.trim().toLowerCase()}`;
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
      const comma = text.indexOf(',');
      if (comma < 0) { meta = null; continue; }
      const attrs: Record<string, string> = {};
      for (const match of text.slice(0, comma).matchAll(/([\w-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
      meta = { title: text.slice(comma + 1).trim() || attrs['tvg-name'] || 'Untitled channel', attrs };
    } else if (meta && text && !text.startsWith('#')) {
      try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        const region = meta.attrs['tvg-country'] || meta.attrs['tvg-language'] || '';
        const quality = /\b(4K|UHD|FHD|1080P|720P|HD|SD)\b/i.exec(meta.title)?.[1]?.toUpperCase() || '';
        items.push({ kind: 'channel', title: meta.title, externalId: meta.attrs['tvg-id'], sourceRef: String(items.length), url: text, quality, group: meta.attrs['group-title'] || '', region, artwork: meta.attrs['tvg-logo'] || '' });
        if (items.length > 25000) throw new Error('Playlist exceeds the 25,000-channel safety limit.');
      } catch (error) { if (error instanceof Error && error.message.includes('25,000')) throw error; }
      meta = null;
    }
  }
  return items;
}

export async function* scanFolder(root: string): AsyncGenerator<ImportItem> {
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
