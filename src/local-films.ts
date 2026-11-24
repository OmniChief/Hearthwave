import { providerJson } from './adapters/network.ts';
import { libraryMatchKey } from './catalogue.ts';
import type { ImportItem } from './model.ts';

interface Movie {
  id?: string;
  name?: string;
  releaseInfo?: string;
  year?: number;
  poster?: string;
  description?: string;
  genres?: string[];
}

async function request(path: string) {
  return await providerJson('https://v3-cinemeta.strem.io/' + path, { maxBytes:1024 * 1024 }) as {
    metas?:Movie[]; meta?:Movie;
  };
}

export async function lookupLocalFilm(raw: string, year: number | null): Promise<Partial<ImportItem> | null> {
  const title = raw.replace(/[._]+/g, ' ').replace(/\s+[\[(]?(?:2160p|1080p|720p|bluray|blu-ray|web[- ]?(?:dl|rip)|x26[45])\b.*$/i, '').trim();
  const term = year ? title.replace(new RegExp('\\s+[\\[(]?' + year + '[\\])]?$'), '').trim() || title : title;
  const result = await request('catalog/movie/top/search=' + encodeURIComponent(term) + '.json');
  const candidates = (result.metas || []).filter((movie: Movie) =>
    movie.name && libraryMatchKey(movie.name) === libraryMatchKey(term) &&
    (!year || Number(String(movie.year || movie.releaseInfo).slice(0,4)) === year));
  if (candidates.length !== 1 || !/^tt\d+$/.test(candidates[0].id || '')) return null;
  const { meta } = await request('meta/movie/' + candidates[0].id + '.json') as { meta?: Movie };
  if (!meta || meta.id !== candidates[0].id) return null;
  return { artwork:meta.poster, description:meta.description, genres:meta.genres?.join(', '),
    imdbId:meta.id, year:Number(String(meta.year || meta.releaseInfo).slice(0,4)) || null };
}

