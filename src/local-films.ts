import { db, enrichTitleMetadata } from './db.ts';
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

// Indexing finishes independently of the network. Start with existing imports after an update.
let running = false;
let requested = false;
export function fillLocalFilmMetadata() {
  requested = true;
  if (running) return;
  running = true;
  void (async () => {
    const next = db.prepare('SELECT t.id,t.title,t.year,t.artwork,t.description FROM titles t ' +
      "WHERE t.id>? AND t.kind='film' AND (COALESCE(t.artwork,'')='' OR COALESCE(t.description,'')='') " +
      "AND EXISTS (SELECT 1 FROM variants v JOIN sources s ON s.id=v.source_id WHERE v.title_id=t.id AND s.type='folder') " +
      'ORDER BY t.id LIMIT 1');
    while (requested) {
      requested = false;
      let cursor = 0;
      for (;;) {
        const film = next.get(cursor) as {id:number; title:string; year:number|null; artwork:string; description:string} | undefined;
        if (!film) break;
        cursor = film.id;
        const info = await lookupLocalFilm(film.title, film.year);
        if (info) {
          if (film.artwork) delete info.artwork;
          if (film.description) delete info.description;
          enrichTitleMetadata(film.id, info);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  })().catch(error => console.warn('Local movie metadata lookup paused:', error.message))
    .finally(() => { running = false; });
}
