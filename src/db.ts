import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalKey, channelCountry, channelGenre, channelKey, cleanTitle, displayChannelTitle, displayLibraryTitle, libraryMatchKey } from './catalogue.ts';
import { secretStore } from './secrets.ts';
import type { ImportItem, MediaKind, ProviderCategory, ProviderConfig, SourceInput, User } from './model.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.HEARTHWAVE_DATA_DIR || join(packageRoot, 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { chmodSync(dataDir, 0o700); } catch { /* Some NAS file systems do not implement POSIX permissions. */ }
const secrets = secretStore(dataDir);

export const db = new DatabaseSync(join(dataDir, 'hearthwave.sqlite'), { enableForeignKeyConstraints: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;');
const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
if (schemaVersion > 8) throw new Error(`Database schema ${schemaVersion} requires a newer Hearthwave version.`);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','viewer')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'not_imported',
    last_import TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS titles (
    id INTEGER PRIMARY KEY, canonical_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    title TEXT NOT NULL, year INTEGER, season INTEGER, episode INTEGER,
    group_name TEXT, artwork TEXT
  );
  CREATE INDEX IF NOT EXISTS titles_kind ON titles(kind, title COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS variants (
    id INTEGER PRIMARY KEY, title_id INTEGER NOT NULL REFERENCES titles(id),
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    source_ref TEXT NOT NULL, url TEXT NOT NULL, quality TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '', generation TEXT NOT NULL,
    UNIQUE(source_id, source_ref)
  );
  CREATE INDEX IF NOT EXISTS variants_title ON variants(title_id);
  CREATE TABLE IF NOT EXISTS favourites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id, title_id)
  );
  CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    position_seconds REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(user_id, title_id)
  );
`);
if (schemaVersion < 2) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE sources ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE provider_categories (
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('live','vod','series')),
      category_id TEXT NOT NULL, name TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id,kind,category_id)
    );
    PRAGMA user_version = 2;
    COMMIT;
  `);
}
if (schemaVersion < 3) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE variants ADD COLUMN series_parent_id INTEGER REFERENCES titles(id) ON DELETE SET NULL;
    ALTER TABLE variants ADD COLUMN episode_name TEXT NOT NULL DEFAULT '';
    CREATE INDEX variants_series_parent ON variants(series_parent_id,source_id);
    PRAGMA user_version = 3;
    COMMIT;
  `);
}
if (schemaVersion < 4) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE titles ADD COLUMN channel_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE titles ADD COLUMN channel_country TEXT NOT NULL DEFAULT '';
    CREATE INDEX titles_channel_identity ON titles(kind,channel_key,channel_country);
    ALTER TABLE variants ADD COLUMN epg_id TEXT NOT NULL DEFAULT '';
    CREATE TABLE guide_feeds (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_imported', last_import TEXT, last_error TEXT
    );
    CREATE TABLE guide_channels (
      feed_id INTEGER NOT NULL REFERENCES guide_feeds(id) ON DELETE CASCADE,
      generation TEXT NOT NULL, channel_id TEXT NOT NULL,
      name TEXT NOT NULL, name_key TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(feed_id,generation,channel_id)
    );
    CREATE INDEX guide_channels_match ON guide_channels(name_key,feed_id,generation);
    CREATE TABLE guide_programmes (
      feed_id INTEGER NOT NULL REFERENCES guide_feeds(id) ON DELETE CASCADE,
      generation TEXT NOT NULL, channel_id TEXT NOT NULL,
      starts INTEGER NOT NULL, ends INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(feed_id,generation,channel_id,starts,title)
    );
    CREATE INDEX guide_programmes_lookup ON guide_programmes(feed_id,generation,channel_id,starts);
  `);
  try {
    const existing = db.prepare("SELECT id,title,group_name FROM titles WHERE kind='channel'").all() as Array<{id:number;title:string;group_name:string}>;
    const update = db.prepare('UPDATE titles SET channel_key=?,channel_country=? WHERE id=?');
    for (const row of existing) update.run(channelKey(row.title),channelCountry(row.title,row.group_name),row.id);
    db.exec('PRAGMA user_version = 4; COMMIT;');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
if (schemaVersion < 5) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE titles ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE titles ADD COLUMN genres TEXT NOT NULL DEFAULT '';
    ALTER TABLE titles ADD COLUMN rating REAL;
    ALTER TABLE titles ADD COLUMN duration_seconds INTEGER;
    CREATE TABLE guide_mappings (
      title_id INTEGER PRIMARY KEY REFERENCES titles(id) ON DELETE CASCADE,
      feed_id INTEGER NOT NULL REFERENCES guide_feeds(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL
    );
    PRAGMA user_version = 5;
    COMMIT;
  `);
}
if (schemaVersion < 6) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE titles ADD COLUMN match_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE titles ADD COLUMN imdb_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE titles ADD COLUMN tmdb_id TEXT NOT NULL DEFAULT '';
    CREATE INDEX titles_library_match ON titles(kind,match_key,year);
    CREATE INDEX titles_library_imdb ON titles(kind,imdb_id) WHERE imdb_id<>'';
    CREATE INDEX titles_library_tmdb ON titles(kind,tmdb_id) WHERE tmdb_id<>'';
  `);
  try {
    // Process existing rows in small pages; avoid materialising a full provider catalogue in RAM.
    const batch=db.prepare("SELECT id,title FROM titles WHERE kind IN ('film','series') AND id>? ORDER BY id LIMIT 512");
    const update=db.prepare('UPDATE titles SET match_key=?,title=? WHERE id=?');
    let cursor=0;
    for (;;) {
      const rows=batch.all(cursor) as Array<{id:number;title:string}>;
      if (!rows.length) break;
      for (const row of rows) update.run(libraryMatchKey(row.title),displayLibraryTitle(row.title),row.id);
      cursor=rows[rows.length-1].id;
    }
    // Merge only unambiguous identities; distinct known release years stay separate.
    const duplicates=db.prepare(`SELECT kind,match_key FROM titles WHERE match_key<>''
      AND kind IN ('film','series') GROUP BY kind,match_key HAVING COUNT(*)>1`).all() as Array<{kind:string;match_key:string}>;
    const candidates=db.prepare('SELECT id,year FROM titles WHERE kind=? AND match_key=? ORDER BY id');
    const read=db.prepare('SELECT * FROM titles WHERE id=?');
    const fill=db.prepare(`UPDATE titles SET year=?,artwork=?,description=?,genres=?,rating=?,duration_seconds=?,imdb_id=?,tmdb_id=? WHERE id=?`);
    const variants=db.prepare('UPDATE variants SET title_id=? WHERE title_id=?');
    const children=db.prepare('UPDATE variants SET series_parent_id=? WHERE series_parent_id=?');
    const favourites=db.prepare('INSERT OR IGNORE INTO favourites(user_id,title_id) SELECT user_id,? FROM favourites WHERE title_id=?');
    const progress=db.prepare(`INSERT INTO progress(user_id,title_id,position_seconds,updated_at)
      SELECT user_id,?,position_seconds,updated_at FROM progress WHERE title_id=?
      ON CONFLICT(user_id,title_id) DO UPDATE SET position_seconds=MAX(progress.position_seconds,excluded.position_seconds)`);
    const remove=db.prepare('DELETE FROM titles WHERE id=?');
    type MergeTitle={year:number|null;artwork:string|null;description:string;genres:string;rating:number|null;duration_seconds:number|null;imdb_id:string;tmdb_id:string};
    const merge=(primaryId:number,duplicateId:number):void=>{
      const a=read.get(primaryId) as MergeTitle;
      const b=read.get(duplicateId) as MergeTitle;
      fill.run(a.year || b.year || null,a.artwork || b.artwork || '',a.description || b.description || '',a.genres || b.genres || '',a.rating ?? b.rating ?? null,a.duration_seconds ?? b.duration_seconds ?? null,a.imdb_id || b.imdb_id || '',a.tmdb_id || b.tmdb_id || '',primaryId);
      favourites.run(primaryId,duplicateId);
      progress.run(primaryId,duplicateId);
      variants.run(primaryId,duplicateId);
      children.run(primaryId,duplicateId);
      remove.run(duplicateId);
    };
    for (const group of duplicates) {
      const rows=candidates.all(group.kind,group.match_key) as Array<{id:number;year:number|null}>;
      const years=[...new Set(rows.map(row=>row.year).filter((year):year is number=>year!=null))];
      const buckets=years.length<=1 ? [rows] : [...years.map(year=>rows.filter(row=>row.year===year)),rows.filter(row=>row.year==null)];
      for (const members of buckets) for (let index=1;index<members.length;index++) merge(members[0].id,members[index].id);
    }
    db.exec('PRAGMA user_version = 6; COMMIT;');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
if (schemaVersion < 7) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE user_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      autoplay_next INTEGER NOT NULL DEFAULT 0 CHECK(autoplay_next IN (0,1))
    );
    PRAGMA user_version = 7;
    COMMIT;
  `);
}
if (schemaVersion < 8) {
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE titles ADD COLUMN live_genre TEXT NOT NULL DEFAULT 'Other';
    CREATE INDEX titles_live_browse ON titles(kind,channel_country,live_genre,title COLLATE NOCASE);
  `);
  try {
    const batch=db.prepare("SELECT id,title,group_name FROM titles WHERE kind='channel' AND id>? ORDER BY id LIMIT 512");
    const update=db.prepare('UPDATE titles SET live_genre=? WHERE id=?');
    let cursor=0;
    for (;;) {
      const rows=batch.all(cursor) as Array<{id:number;title:string;group_name:string}>;
      if (!rows.length) break;
      for (const row of rows) update.run(channelGenre(row.title,row.group_name||''),row.id);
      cursor=rows[rows.length-1].id;
    }
    db.exec('PRAGMA user_version = 8; COMMIT;');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
db.prepare("UPDATE sources SET status='interrupted',last_error='Previous source operation was interrupted; run it again.' WHERE status IN ('scanning','discovering')").run();
db.prepare("UPDATE guide_feeds SET status='interrupted',last_error='Previous guide import was interrupted; import again.' WHERE status='importing'").run();

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function hasUsers(): boolean {
  return Number((db.prepare('SELECT COUNT(*) AS total FROM users').get() as { total: number }).total) > 0;
}

export function createUser(username: string, passwordHash: string, role: User['role']): User {
  const result = db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run(username, passwordHash, role);
  return { id: Number(result.lastInsertRowid), username, role };
}

export function findUser(username: string): (User & { password_hash: string }) | undefined {
  return db.prepare('SELECT id,username,role,password_hash FROM users WHERE username = ?').get(username) as (User & { password_hash: string }) | undefined;
}

export function publicUsers(): User[] {
  return db.prepare('SELECT id,username,role FROM users ORDER BY id').all() as unknown as User[];
}

export function getUserPreferences(userId:number): {autoplayNext:boolean} {
  const row=db.prepare('SELECT autoplay_next FROM user_preferences WHERE user_id=?').get(userId) as {autoplay_next:number}|undefined;
  return {autoplayNext:row?.autoplay_next===1};
}

export function setUserPreferences(userId:number,autoplayNext:boolean): {autoplayNext:boolean} {
  db.prepare(`INSERT INTO user_preferences(user_id,autoplay_next) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET autoplay_next=excluded.autoplay_next`).run(userId,autoplayNext?1:0);
  return {autoplayNext};
}

export function saveSession(hash: string, userId: number, csrf: string, expiry: number): void {
  db.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)').run(hash, userId, csrf, expiry);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export function loadSession(hash: string): { user: User; csrf: string } | null {
  const row = db.prepare('SELECT u.id,u.username,u.role,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?')
    .get(hash, Date.now()) as ({ id: number; username: string; role: User['role']; csrf_token: string }) | undefined;
  return row ? { user: { id: row.id, username: row.username, role: row.role }, csrf: row.csrf_token } : null;
}

export function removeSession(hash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
}

export interface SourceRow { id: number; name: string; type: SourceInput['type']; location: string; config: ProviderConfig; status: string; last_import: string | null; last_error: string | null }

function unpackSource(source: Omit<SourceRow, 'config'> & { config: string }): SourceRow {
  return { ...source, location: secrets.open(source.location), config: JSON.parse(secrets.open(source.config || '{}')) as ProviderConfig };
}

export function listSources(): SourceRow[] {
  return (db.prepare('SELECT id,name,type,location,config,status,last_import,last_error FROM sources ORDER BY id').all() as unknown as Array<Omit<SourceRow,'config'> & { config: string }>).map(unpackSource);
}

export function getSource(id: number): SourceRow | undefined {
  const source = db.prepare('SELECT id,name,type,location,config,status,last_import,last_error FROM sources WHERE id=?').get(id) as (Omit<SourceRow,'config'> & { config: string }) | undefined;
  return source ? unpackSource(source) : undefined;
}

export function addSource(input: SourceInput): SourceRow {
  const result = db.prepare('INSERT INTO sources (name,type,location,config) VALUES (?,?,?,?)').run(input.name, input.type, secrets.seal(input.location || ''), secrets.seal(JSON.stringify(input.config || {}), true));
  return getSource(Number(result.lastInsertRowid))!;
}

export function publicSource(source: SourceRow): Omit<SourceRow, 'config'> & { hasCredentials: boolean } {
  const { config, ...safe } = source;
  return { ...safe, hasCredentials: Boolean(config.mac || config.username) };
}

export function listCategories(sourceId: number): ProviderCategory[] {
  return db.prepare('SELECT source_id,kind,category_id,name,selected FROM provider_categories WHERE source_id=? ORDER BY kind,name COLLATE NOCASE').all(sourceId) as unknown as ProviderCategory[];
}

export function saveCategories(sourceId: number, found: Array<{ kind: ProviderCategory['kind']; id: string; name: string }>): void {
  if (found.length > 3000) throw new Error('Provider returned too many categories.');
  transaction(() => {
    const upsert = db.prepare(`INSERT INTO provider_categories (source_id,kind,category_id,name) VALUES (?,?,?,?)
      ON CONFLICT(source_id,kind,category_id) DO UPDATE SET name=excluded.name`);
    const seen = new Set<string>();
    for (const row of found) {
      if (!row.id || !row.name) continue;
      upsert.run(sourceId, row.kind, row.id, row.name);
      seen.add(`${row.kind}\0${row.id}`);
    }
    for (const row of listCategories(sourceId)) if (!seen.has(`${row.kind}\0${row.category_id}`))
      db.prepare('DELETE FROM provider_categories WHERE source_id=? AND kind=? AND category_id=?').run(sourceId,row.kind,row.category_id);
  });
}

export function selectCategories(sourceId: number, selected: Array<{ kind: ProviderCategory['kind']; id: string }>): void {
  transaction(() => {
    db.prepare('UPDATE provider_categories SET selected=0 WHERE source_id=?').run(sourceId);
    const update = db.prepare('UPDATE provider_categories SET selected=1 WHERE source_id=? AND kind=? AND category_id=?');
    for (const row of selected) if (update.run(sourceId,row.kind,row.id).changes !== 1) throw new Error('Unknown provider category. Reload and try again.');
  });
}

export function deleteSource(id: number): boolean {
  return db.prepare('DELETE FROM sources WHERE id=?').run(id).changes > 0;
}

export function setSourceStatus(id: number, status: string, error: string | null = null): void {
  db.prepare("UPDATE sources SET status=?,last_error=?,last_import=CASE WHEN ?='ready' THEN CURRENT_TIMESTAMP ELSE last_import END WHERE id=?")
    .run(status, error, status, id);
}

const upsertTitle = db.prepare(`
  INSERT INTO titles (canonical_key,kind,title,year,season,episode,group_name,artwork,channel_key,channel_country,description,genres,rating,duration_seconds,match_key,imdb_id,tmdb_id,live_genre)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(canonical_key) DO UPDATE SET
    title=CASE WHEN excluded.kind='channel' AND LENGTH(excluded.title)<LENGTH(titles.title) THEN excluded.title ELSE titles.title END,
    artwork=COALESCE(NULLIF(titles.artwork,''), excluded.artwork),
    group_name=COALESCE(NULLIF(titles.group_name,''), excluded.group_name),
    channel_key=COALESCE(NULLIF(titles.channel_key,''), excluded.channel_key),
    channel_country=COALESCE(NULLIF(titles.channel_country,''), excluded.channel_country),
    live_genre=CASE WHEN titles.live_genre='Other' THEN excluded.live_genre ELSE titles.live_genre END,
    description=COALESCE(NULLIF(titles.description,''), excluded.description),
    genres=COALESCE(NULLIF(titles.genres,''), excluded.genres),
    rating=COALESCE(titles.rating, excluded.rating),
    duration_seconds=COALESCE(titles.duration_seconds, excluded.duration_seconds),
    match_key=COALESCE(NULLIF(titles.match_key,''),excluded.match_key),
    imdb_id=COALESCE(NULLIF(titles.imdb_id,''),excluded.imdb_id),
    tmdb_id=COALESCE(NULLIF(titles.tmdb_id,''),excluded.tmdb_id)
  RETURNING id
`);
const upsertVariant = db.prepare(`
  INSERT INTO variants (title_id,source_id,source_ref,url,quality,group_name,generation,epg_id)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(source_id,source_ref) DO UPDATE SET
    title_id=excluded.title_id, url=excluded.url,quality=excluded.quality,
    group_name=excluded.group_name,generation=excluded.generation,epg_id=excluded.epg_id
`);
const channelCandidates = db.prepare("SELECT id,channel_country FROM titles WHERE kind='channel' AND channel_key=? LIMIT 25");
const existingKey = db.prepare('SELECT id FROM titles WHERE canonical_key=?');
const updateMatchedChannel = db.prepare(`UPDATE titles SET
  title=CASE WHEN LENGTH(title)>LENGTH(?) THEN ? ELSE title END,
  artwork=COALESCE(NULLIF(artwork,''),?),
  channel_country=COALESCE(NULLIF(channel_country,''),?),
  live_genre=CASE WHEN live_genre='Other' THEN ? ELSE live_genre END WHERE id=?`);
const byImdb=db.prepare("SELECT id,year,imdb_id,tmdb_id FROM titles WHERE kind=? AND imdb_id=? LIMIT 3");
const byTmdb=db.prepare("SELECT id,year,imdb_id,tmdb_id FROM titles WHERE kind=? AND tmdb_id=? LIMIT 3");
const byLibraryName=db.prepare('SELECT id,year,imdb_id,tmdb_id FROM titles WHERE kind=? AND match_key=? LIMIT 40');
const updateMatchedLibrary=db.prepare(`UPDATE titles SET
  year=COALESCE(year,?),artwork=COALESCE(NULLIF(artwork,''),?),
  description=COALESCE(NULLIF(description,''),?),genres=COALESCE(NULLIF(genres,''),?),
  rating=COALESCE(rating,?),duration_seconds=COALESCE(duration_seconds,?),
  imdb_id=COALESCE(NULLIF(imdb_id,''),?),tmdb_id=COALESCE(NULLIF(tmdb_id,''),?) WHERE id=?`);
interface LibraryCandidate { id:number;year:number|null;imdb_id:string;tmdb_id:string }
function metadataIds(item:ImportItem):{imdb:string;tmdb:string} {
  const imdb=/^tt\d{5,12}$/i.test(item.imdbId || '') ? item.imdbId!.toLowerCase() : '';
  const tmdb=/^[1-9]\d{0,11}$/.test(item.tmdbId || '') ? item.tmdbId! : '';
  return {imdb,tmdb};
}
/** IDs outrank names; unknown years merge only when there is one unambiguous candidate. */
function matchedLibraryTitle(item:ImportItem,matchKey:string,imdb:string,tmdb:string):number|null {
  if (!['film','series'].includes(item.kind) || !matchKey) return null;
  const compatible=(row:LibraryCandidate)=> (!imdb || !row.imdb_id || imdb===row.imdb_id) && (!tmdb || !row.tmdb_id || tmdb===row.tmdb_id);
  for (const [statement,id] of [[byImdb,imdb],[byTmdb,tmdb]] as const) {
    if (!id) continue;
    const matches=(statement.all(item.kind,id) as LibraryCandidate[]).filter(compatible);
    if (matches.length===1) return matches[0].id;
    if (matches.length>1) return null;
  }
  const rows=(byLibraryName.all(item.kind,matchKey) as LibraryCandidate[]).filter(compatible);
  if (rows.length>=40) return null;
  const exact=rows.filter(row=>row.year!=null && row.year===item.year);
  if (exact.length===1) return exact[0].id;
  if (exact.length>1) return null;
  if (rows.length===1 && (rows[0].year==null || item.year==null)) return rows[0].id;
  return null;
}

export function importBatch(sourceId: number, items: ImportItem[], generation: string): void {
  transaction(() => {
    for (const item of items) {
      const key = canonicalKey(item);
      const name = item.kind === 'channel' ? displayChannelTitle(item.title) : ['film','series'].includes(item.kind) ? displayLibraryTitle(item.title) : cleanTitle(item.title).replace(/^(?:UK|US|USA|EN)\s*[-:|]\s*/i, '').replace(/\s+(?:UHD|FHD|4K|HD|SD|1080P)$/i, '').trim();
      const identity = item.kind === 'channel' ? channelKey(item.title) : '';
      const country = item.kind === 'channel' ? channelCountry(item.title,item.group,item.region) : '';
      const genre = item.kind === 'channel' ? channelGenre(item.title,item.group||'') : 'Other';
      const existing = item.kind === 'channel' && !existingKey.get(key) ? channelCandidates.all(identity) as Array<{id:number;channel_country:string}> : [];
      const compatible = existing.filter(row => !country || !row.channel_country || row.channel_country === country);
      const matchKey = ['film','series'].includes(item.kind) ? libraryMatchKey(item.title) : '';
      const {imdb,tmdb}=metadataIds(item);
      let titleId: number;
      if (compatible.length === 1 && existing.length === 1) {
        titleId = compatible[0].id;
        updateMatchedChannel.run(name,name,item.artwork || '',country,genre,titleId);
      } else {
        const merged = !existingKey.get(key) ? matchedLibraryTitle(item,matchKey,imdb,tmdb) : null;
        if (merged!=null) {
          titleId=merged;
          updateMatchedLibrary.run(item.year ?? null,item.artwork || '',(item.description || '').slice(0,4000),(item.genres || '').slice(0,250),item.rating ?? null,item.durationSeconds ?? null,imdb,tmdb,titleId);
        } else {
          titleId = Number((upsertTitle.get(key, item.kind, name, item.year || null, item.season || null, item.episode || null, item.group || '', item.artwork || '',identity,country,(item.description || '').slice(0,4000),(item.genres || '').slice(0,250),item.rating ?? null,item.durationSeconds ?? null,matchKey,imdb,tmdb,genre) as { id: number }).id);
        }
      }
      upsertVariant.run(titleId, sourceId, item.sourceRef, secrets.seal(item.url, true), item.quality || '', item.group || '', generation,(item.externalId || '').trim().toLowerCase().slice(0,200));
    }
  });
}

export function completeImport(sourceId: number, generation: string): void {
  transaction(() => {
    db.prepare('DELETE FROM variants WHERE source_id=? AND series_parent_id IS NULL AND generation<>?').run(sourceId, generation);
    db.prepare(`DELETE FROM variants WHERE source_id=? AND series_parent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM variants root WHERE root.source_id=variants.source_id
        AND root.title_id=variants.series_parent_id AND root.series_parent_id IS NULL)`).run(sourceId);
    setSourceStatus(sourceId, 'ready');
  });
}

export type CatalogueView='all'|'favourites'|'continue';
export type CatalogueSort='title'|'year'|'added'|'activity';
export function listTitles(kind: MediaKind | 'all' | 'library', userId: number, query = '', view:CatalogueView='all', sort:CatalogueSort='title', limit=250,offset=0,country='',genre=''): unknown[] {
  const search = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const order=kind==='channel' ? `CASE t.channel_country WHEN 'GB' THEN 0 WHEN 'US' THEN 1 ELSE 2 END,
    CASE t.live_genre WHEN 'General' THEN 0 WHEN 'Entertainment' THEN 1 WHEN 'Sports' THEN 2
      WHEN 'Movies' THEN 3 WHEN 'News' THEN 4 WHEN 'Kids' THEN 5 WHEN 'Documentary' THEN 6
      WHEN 'Music' THEN 7 ELSE 8 END,t.title COLLATE NOCASE ASC,t.id ASC`
    : {title:'t.title COLLATE NOCASE ASC,t.id ASC',year:'(t.year IS NULL),t.year DESC,t.title COLLATE NOCASE ASC,t.id ASC',added:'t.id DESC',activity:'(p.updated_at IS NULL),p.updated_at DESC,t.id DESC'}[sort];
  return db.prepare(`
    SELECT t.id,t.kind,t.title,t.year,t.season,t.episode,t.group_name,t.artwork,t.channel_country,t.live_genre,
      COUNT(v.id) AS source_count,
      CASE WHEN f.title_id IS NULL THEN 0 ELSE 1 END AS favourite,
      p.position_seconds
    FROM titles t JOIN variants v ON v.title_id=t.id AND (v.series_parent_id IS NULL OR ?='episode')
    LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE (?='all' OR (?='library' AND t.kind<>'channel') OR t.kind=?) AND t.title LIKE ? ESCAPE '\\'
      AND (?='all' OR (?='favourites' AND f.title_id IS NOT NULL) OR (?='continue' AND p.position_seconds>0))
      AND (?='' OR (?='other' AND t.channel_country NOT IN ('GB','US')) OR t.channel_country=?)
      AND (?='' OR t.live_genre=?)
    GROUP BY t.id ORDER BY ${order} LIMIT ? OFFSET ?
  `).all(kind,userId,userId,kind,kind,kind,search,view,view,view,country,country,country,genre,genre,Math.min(250,Math.max(1,limit)),Math.max(0,offset));
}

export function countTitles(kind: MediaKind | 'all' | 'library',userId:number,query='',view:CatalogueView='all',country='',genre=''):number {
  const search=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
  return Number((db.prepare(`SELECT COUNT(*) AS total FROM titles t
    LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE (?='all' OR (?='library' AND t.kind<>'channel') OR t.kind=?) AND t.title LIKE ? ESCAPE '\\'
      AND (?='all' OR (?='favourites' AND f.title_id IS NOT NULL) OR (?='continue' AND p.position_seconds>0))
      AND (?='' OR (?='other' AND t.channel_country NOT IN ('GB','US')) OR t.channel_country=?)
      AND (?='' OR t.live_genre=?)
      AND EXISTS (SELECT 1 FROM variants v WHERE v.title_id=t.id AND (v.series_parent_id IS NULL OR ?='episode'))`)
      .get(userId,userId,kind,kind,kind,search,view,view,view,country,country,country,genre,genre,kind) as {total:number}).total);
}

export function channelGenreCounts(country='',query=''):Array<{name:string;count:number}> {
  const search=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
  return db.prepare(`SELECT t.live_genre AS name,COUNT(*) AS count FROM titles t
    WHERE t.kind='channel' AND t.title LIKE ? ESCAPE '\\'
      AND (?='' OR (?='other' AND t.channel_country NOT IN ('GB','US')) OR t.channel_country=?)
      AND EXISTS (SELECT 1 FROM variants v WHERE v.title_id=t.id AND v.series_parent_id IS NULL)
    GROUP BY t.live_genre`).all(search,country,country,country) as Array<{name:string;count:number}>;
}

export function titleExists(id: number): boolean {
  return !!db.prepare('SELECT id FROM titles WHERE id=?').get(id);
}

export function getTitle(id: number): { id: number; title: string; kind: MediaKind; year: number | null } | undefined {
  return db.prepare('SELECT id,title,kind,year FROM titles WHERE id=?').get(id) as { id:number; title:string; kind:MediaKind; year:number|null } | undefined;
}

export function getTitleDetail(id:number,userId:number): unknown | undefined {
  return db.prepare(`SELECT t.id,t.kind,t.title,t.year,t.season,t.episode,t.group_name,t.artwork,
    t.description,t.genres,t.rating,t.duration_seconds,t.imdb_id,t.tmdb_id,t.channel_country,
    (SELECT COUNT(*) FROM variants v WHERE v.title_id=t.id) AS source_count,
    (SELECT MAX(v.episode_name) FROM variants v WHERE v.title_id=t.id) AS episode_name,
    CASE WHEN f.title_id IS NULL THEN 0 ELSE 1 END AS favourite,p.position_seconds
    FROM titles t LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE t.id=? AND EXISTS (SELECT 1 FROM variants v WHERE v.title_id=t.id)`)
    .get(userId,userId,id);
}

/** Explicit provider metadata refresh; blank fields never erase previously indexed information. */
export function enrichTitleMetadata(titleId:number,info:Partial<ImportItem>):boolean {
  const description=typeof info.description==='string'?info.description.trim().slice(0,4000):'';
  const genres=typeof info.genres==='string'?info.genres.trim().slice(0,250):'';
  const artwork=typeof info.artwork==='string' && /^https?:\/\//i.test(info.artwork)?info.artwork.slice(0,2048):'';
  const year=Number.isInteger(info.year) && (info.year as number)>=1880 && (info.year as number)<=2100 ? info.year : null;
  const rating=typeof info.rating==='number' && Number.isFinite(info.rating) && info.rating>0 && info.rating<=10?info.rating:null;
  const duration=Number.isInteger(info.durationSeconds) && (info.durationSeconds as number)>0 && (info.durationSeconds as number)<=172800?info.durationSeconds:null;
  const imdb=/^tt\d{5,12}$/i.test(info.imdbId || '')?info.imdbId!.toLowerCase():'';
  const tmdb=/^[1-9]\d{0,11}$/.test(info.tmdbId || '')?info.tmdbId!:'';
  if (![description,genres,artwork,year,rating,duration,imdb,tmdb].some(value=>value!=null && value!=='')) return false;
  return db.prepare(`UPDATE titles SET year=COALESCE(year,?),
    artwork=COALESCE(NULLIF(?,''),artwork),description=COALESCE(NULLIF(?,''),description),
    genres=COALESCE(NULLIF(?,''),genres),rating=COALESCE(?,rating),
    duration_seconds=COALESCE(?,duration_seconds),
    imdb_id=COALESCE(NULLIF(imdb_id,''),?),tmdb_id=COALESCE(NULLIF(tmdb_id,''),?)
    WHERE id=? AND kind IN ('film','series')`).run(year,artwork,description,genres,rating,duration,imdb,tmdb,titleId).changes>0;
}

const upsertEpisodeVariant = db.prepare(`
  INSERT INTO variants (title_id,source_id,source_ref,url,quality,group_name,generation,series_parent_id,episode_name)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source_id,source_ref) DO UPDATE SET
    title_id=excluded.title_id,url=excluded.url,quality=excluded.quality,
    group_name=excluded.group_name,generation=excluded.generation,series_parent_id=excluded.series_parent_id,
    episode_name=excluded.episode_name
`);

/** Replace just one provider's children of one series; never prune unrelated titles or sources. */
export function replaceSeriesEpisodes(seriesId: number, sourceId: number, items: ImportItem[]): void {
  if (items.length > 1000 || items.some(item => item.kind !== 'episode' || !Number.isInteger(item.season) || !Number.isInteger(item.episode) || (item.episode || 0) < 1))
    throw new Error('Provider returned an invalid or oversized episode collection.');
  const generation = randomUUID();
  transaction(() => {
    for (const item of items) {
      const titleId = Number((upsertTitle.get(canonicalKey(item), 'episode', cleanTitle(item.title), item.year || null, item.season || null, item.episode || null, item.group || '', item.artwork || '','','',(item.description || '').slice(0,4000),(item.genres || '').slice(0,250),item.rating ?? null,item.durationSeconds ?? null,'','','','Other') as {id:number}).id);
      upsertEpisodeVariant.run(titleId,sourceId,item.sourceRef,secrets.seal(item.url,true),item.quality || '',item.group || '',generation,seriesId,(item.episodeName || '').slice(0,250));
    }
    db.prepare('DELETE FROM variants WHERE series_parent_id=? AND source_id=? AND generation<>?').run(seriesId,sourceId,generation);
  });
}

export function listSeriesEpisodes(seriesId: number, userId: number): unknown[] {
  return db.prepare(`
    SELECT t.id,t.kind,t.title,t.year,t.season,t.episode,t.group_name,t.artwork,t.description,MAX(v.episode_name) AS episode_name,
      COUNT(v.id) AS source_count,
      CASE WHEN f.title_id IS NULL THEN 0 ELSE 1 END AS favourite,p.position_seconds
    FROM variants v JOIN titles t ON t.id=v.title_id
    LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE v.series_parent_id=? GROUP BY t.id
    ORDER BY t.season DESC,t.episode DESC,t.id DESC LIMIT 1000
  `).all(userId,userId,seriesId);
}

export interface VariantRow { id: number; title_id: number; source_id: number; source_ref: string; source_name: string; source_type: string; source_location: string; url: string; quality: string; group_name: string }

export function listVariants(titleId: number): VariantRow[] {
  const rows = db.prepare(`SELECT v.id,v.title_id,v.source_id,v.source_ref,s.name AS source_name,s.type AS source_type,s.location AS source_location,v.url,v.quality,v.group_name
    FROM variants v JOIN sources s ON s.id=v.source_id WHERE v.title_id=? ORDER BY CASE WHEN v.quality IN ('4K','UHD') THEN 0 WHEN v.quality IN ('FHD','1080P') THEN 1 WHEN v.quality='HD' THEN 2 ELSE 3 END, s.id`)
    .all(titleId) as unknown as VariantRow[];
  return rows.map(v => ({ ...v, url: secrets.open(v.url), source_location: secrets.open(v.source_location) }));
}

export function getVariant(id: number): VariantRow | undefined {
  const variant = db.prepare(`SELECT v.id,v.title_id,v.source_id,v.source_ref,s.name AS source_name,s.type AS source_type,s.location AS source_location,v.url,v.quality,v.group_name
    FROM variants v JOIN sources s ON s.id=v.source_id WHERE v.id=?`).get(id) as VariantRow | undefined;
  return variant ? { ...variant, url: secrets.open(variant.url), source_location: secrets.open(variant.source_location) } : undefined;
}

export function setFavourite(userId: number, titleId: number, favourite: boolean): void {
  if (favourite) db.prepare('INSERT OR IGNORE INTO favourites (user_id,title_id) VALUES (?,?)').run(userId, titleId);
  else db.prepare('DELETE FROM favourites WHERE user_id=? AND title_id=?').run(userId, titleId);
}

export function saveProgress(userId: number, titleId: number, seconds: number): void {
  db.prepare(`INSERT INTO progress (user_id,title_id,position_seconds) VALUES (?,?,?)
    ON CONFLICT(user_id,title_id) DO UPDATE SET position_seconds=excluded.position_seconds,updated_at=CURRENT_TIMESTAMP`).run(userId, titleId, seconds);
}

export interface GuideFeed { id:number; name:string; country:string; location:string; generation:string; status:string; last_import:string|null; last_error:string|null }
export interface GuideChannelInput { id:string; name:string; icon:string }
export interface GuideProgrammeInput { channelId:string; start:number; end:number; title:string; description:string }

export function addGuideFeed(name:string, country:string, location:string): GuideFeed {
  const result=db.prepare('INSERT INTO guide_feeds(name,country,location) VALUES(?,?,?)').run(name,country,secrets.seal(location,true));
  return getGuideFeed(Number(result.lastInsertRowid))!;
}
function unpackGuideFeed(row:GuideFeed):GuideFeed { return {...row,location:secrets.open(row.location)}; }
export function getGuideFeed(id:number):GuideFeed|undefined {
  const row=db.prepare('SELECT * FROM guide_feeds WHERE id=?').get(id) as GuideFeed|undefined;
  return row ? unpackGuideFeed(row) : undefined;
}
export function listGuideFeeds():GuideFeed[] {
  return (db.prepare('SELECT * FROM guide_feeds ORDER BY id').all() as unknown as GuideFeed[]).map(unpackGuideFeed);
}
export function publicGuideFeed(row:GuideFeed):GuideFeed & {channel_count:number;programme_count:number} {
  let location=row.location;
  try { const url=new URL(location); if(url.search) url.search='?[redacted]'; location=url.toString(); } catch { location='[invalid URL]'; }
  const count=db.prepare(`SELECT
    (SELECT COUNT(*) FROM guide_channels WHERE feed_id=? AND generation=?) AS channel_count,
    (SELECT COUNT(*) FROM guide_programmes WHERE feed_id=? AND generation=?) AS programme_count`).get(row.id,row.generation,row.id,row.generation) as {channel_count:number;programme_count:number};
  return {...row,location,...count};
}
export function deleteGuideFeed(id:number):void { db.prepare('DELETE FROM guide_feeds WHERE id=?').run(id); }
export function setGuideStatus(id:number,status:string,error:string|null=null):void {
  db.prepare('UPDATE guide_feeds SET status=?,last_error=? WHERE id=?').run(status,error,id);
}
const saveGuideChannel=db.prepare(`INSERT INTO guide_channels(feed_id,generation,channel_id,name,name_key,icon)
  VALUES(?,?,?,?,?,?) ON CONFLICT(feed_id,generation,channel_id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,icon=excluded.icon`);
const saveGuideProgramme=db.prepare(`INSERT OR IGNORE INTO guide_programmes(feed_id,generation,channel_id,starts,ends,title,description) VALUES(?,?,?,?,?,?,?)`);
export function writeGuideChannels(feedId:number,generation:string,rows:GuideChannelInput[]):void {
  transaction(() => { for(const row of rows) saveGuideChannel.run(feedId,generation,row.id,row.name,channelKey(row.name),row.icon); });
}
export function writeGuideProgrammes(feedId:number,generation:string,rows:GuideProgrammeInput[]):void {
  transaction(() => { for(const row of rows) saveGuideProgramme.run(feedId,generation,row.channelId,row.start,row.end,row.title,row.description); });
}
export function finishGuideImport(feedId:number,generation:string,channels:number,programmes:number):void {
  if (!channels || !programmes) throw new Error('Guide had no channels or programmes; the previous guide was retained.');
  transaction(() => {
    db.prepare("UPDATE guide_feeds SET generation=?,status='ready',last_error=NULL,last_import=CURRENT_TIMESTAMP WHERE id=?").run(generation,feedId);
    db.prepare('DELETE FROM guide_channels WHERE feed_id=? AND generation<>?').run(feedId,generation);
    db.prepare('DELETE FROM guide_programmes WHERE feed_id=? AND generation<>?').run(feedId,generation);
  });
}
export function abortGuideImport(feedId:number,generation:string,error:string):void {
  transaction(() => {
    db.prepare('DELETE FROM guide_channels WHERE feed_id=? AND generation=?').run(feedId,generation);
    db.prepare('DELETE FROM guide_programmes WHERE feed_id=? AND generation=?').run(feedId,generation);
    setGuideStatus(feedId,'error',error.slice(0,300));
  });
}

export interface GuideMapping {title_id:number;feed_id:number;channel_id:string;name:string;source:string}
export function getGuideMapping(titleId:number):GuideMapping|undefined {
  return db.prepare(`SELECT m.title_id,m.feed_id,m.channel_id,c.name,f.name AS source
    FROM guide_mappings m JOIN guide_feeds f ON f.id=m.feed_id
    LEFT JOIN guide_channels c ON c.feed_id=m.feed_id AND c.generation=f.generation AND c.channel_id=m.channel_id
    WHERE m.title_id=?`).get(titleId) as GuideMapping|undefined;
}
export function searchGuideChannels(query:string,limit=50):unknown[] {
  const search=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
  return db.prepare(`SELECT c.feed_id,c.channel_id,c.name,c.icon,f.name AS source,f.country
    FROM guide_channels c JOIN guide_feeds f ON f.id=c.feed_id AND f.generation=c.generation
    WHERE c.name LIKE ? ESCAPE '\\' OR c.channel_id LIKE ? ESCAPE '\\'
    ORDER BY c.name COLLATE NOCASE LIMIT ?`).all(search,search,limit);
}
export function saveGuideMapping(titleId:number,feedId:number,channelId:string):void {
  const valid=db.prepare(`SELECT c.channel_id FROM guide_channels c JOIN guide_feeds f
    ON f.id=c.feed_id AND f.generation=c.generation
    WHERE c.feed_id=? AND c.channel_id=?`).get(feedId,channelId);
  if (getTitle(titleId)?.kind!=='channel' || !valid) throw new Error('Select an existing live channel and an imported XMLTV channel.');
  db.prepare(`INSERT INTO guide_mappings(title_id,feed_id,channel_id) VALUES(?,?,?)
    ON CONFLICT(title_id) DO UPDATE SET feed_id=excluded.feed_id,channel_id=excluded.channel_id`).run(titleId,feedId,channelId);
}
export function removeGuideMapping(titleId:number):void { db.prepare('DELETE FROM guide_mappings WHERE title_id=?').run(titleId); }

export function storedGuide(titleId:number,limit=12,windowStart?:number,windowEnd?:number): { programmes:Array<{title:string;description:string;start:string;end:string}>; source:string; icon:string } {
  const title=db.prepare("SELECT channel_key,channel_country,canonical_key FROM titles WHERE id=? AND kind='channel'").get(titleId) as {channel_key:string;channel_country:string;canonical_key:string}|undefined;
  if (!title) return {programmes:[],source:'',icon:''};
  const mapping=getGuideMapping(titleId);
  const epgIds=new Set((db.prepare("SELECT epg_id FROM variants WHERE title_id=? AND epg_id<>''").all(titleId) as Array<{epg_id:string}>).map(row=>row.epg_id.toLowerCase()));
  const encoded=/^channel:[^:]*:epg:(.+)$/.exec(title.canonical_key)?.[1];
  if(encoded) epgIds.add(encoded.toLowerCase());
  const ids=[...epgIds].slice(0,40);
  const rows=db.prepare(`SELECT c.feed_id,c.generation,c.channel_id,c.name,c.name_key,c.icon,
      f.name AS source,f.country
    FROM guide_channels c JOIN guide_feeds f ON f.id=c.feed_id AND f.generation=c.generation
    WHERE ${mapping ? '(c.feed_id=? AND c.channel_id=?)' : `(c.name_key=?${ids.length ? ` OR LOWER(c.channel_id) IN (${ids.map(()=>'?').join(',')})` : ''})`}
    LIMIT 80`).all(...(mapping ? [mapping.feed_id,mapping.channel_id] : [title.channel_key,...ids])) as Array<{feed_id:number;generation:string;channel_id:string;name:string;name_key:string;icon:string;source:string;country:string}>;
  const exact=rows.filter(row=>epgIds.has(row.channel_id.toLowerCase()));
  const sameCountry=rows.filter(row=>!title.channel_country || !row.country || title.channel_country===row.country);
  const possible=mapping ? rows.filter(row=>row.feed_id===mapping.feed_id && row.channel_id===mapping.channel_id) : exact.length ? exact : sameCountry.filter(row=>row.name_key===title.channel_key);
  const countries=new Set(possible.map(row=>row.country).filter(Boolean));
  if (!mapping && !exact.length && !title.channel_country && countries.size>1) return {programmes:[],source:'',icon:''};
  const now=Math.floor(Date.now()/1000);
  const from=windowStart??now-1800;
  const until=windowEnd??now+86400;
  const fallback=possible[0];
  for (const row of possible) {
    const items=db.prepare(`SELECT title,description,starts,ends FROM guide_programmes
      WHERE feed_id=? AND generation=? AND channel_id=? AND ends>? AND starts<?
      ORDER BY starts LIMIT ?`).all(row.feed_id,row.generation,row.channel_id,from,until,Math.min(48,Math.max(1,limit))) as Array<{title:string;description:string;starts:number;ends:number}>;
    if (items.length) return {programmes:items.map(item=>({title:item.title,description:item.description,start:new Date(item.starts*1000).toISOString(),end:new Date(item.ends*1000).toISOString()})),source:row.source,icon:row.icon};
  }
  return {programmes:[],source:fallback?.source||'',icon:fallback?.icon||''};
}

export function guideGrid(country:string,limit=40,query='',offset=0,windowStart?:number,windowEnd?:number):{items:unknown[];total:number} {
  const search=`%${query.replace(/[\\%_]/g,'\\$&')}%`;
  const total=Number((db.prepare(`SELECT COUNT(*) AS total FROM titles t WHERE t.kind='channel'
    AND (?='' OR t.channel_country=?) AND t.title LIKE ? ESCAPE '\\'
    AND EXISTS (SELECT 1 FROM variants v WHERE v.title_id=t.id AND v.series_parent_id IS NULL)`)
    .get(country,country,search) as {total:number}).total);
  const rows=db.prepare(`SELECT t.id,t.kind,t.title,t.artwork,t.channel_country,COUNT(v.id) AS source_count
    FROM titles t JOIN variants v ON v.title_id=t.id AND v.series_parent_id IS NULL
    WHERE t.kind='channel' AND (?='' OR t.channel_country=?) AND t.title LIKE ? ESCAPE '\\'
    GROUP BY t.id ORDER BY t.title COLLATE NOCASE LIMIT ? OFFSET ?`).all(country,country,search,limit,offset) as Array<{id:number;title:string;artwork:string;channel_country:string;source_count:number}>;
  return {items:rows.map(row=>{ const guide=storedGuide(row.id,48,windowStart,windowEnd);return {...row,artwork:row.artwork || guide.icon,guide}; }),total};
}

export function dashboardStats(): { items: number; channels: number; sources: number } {
  const items = Number((db.prepare("SELECT COUNT(*) AS total FROM titles WHERE kind<>'channel' AND EXISTS (SELECT 1 FROM variants WHERE title_id=titles.id)").get() as { total: number }).total);
  const channels = Number((db.prepare("SELECT COUNT(*) AS total FROM titles WHERE kind='channel' AND EXISTS (SELECT 1 FROM variants WHERE title_id=titles.id)").get() as { total: number }).total);
  return { items, channels, sources: listSources().length };
}
