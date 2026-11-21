import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalKey, cleanTitle } from './catalogue.ts';
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
if (schemaVersion > 3) throw new Error(`Database schema ${schemaVersion} requires a newer Hearthwave version.`);
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
db.prepare("UPDATE sources SET status='interrupted',last_error='Previous source operation was interrupted; run it again.' WHERE status IN ('scanning','discovering')").run();

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
  INSERT INTO titles (canonical_key,kind,title,year,season,episode,group_name,artwork)
  VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(canonical_key) DO UPDATE SET
    artwork=COALESCE(NULLIF(titles.artwork,''), excluded.artwork),
    group_name=COALESCE(NULLIF(titles.group_name,''), excluded.group_name)
  RETURNING id
`);
const upsertVariant = db.prepare(`
  INSERT INTO variants (title_id,source_id,source_ref,url,quality,group_name,generation)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(source_id,source_ref) DO UPDATE SET
    title_id=excluded.title_id, url=excluded.url,quality=excluded.quality,
    group_name=excluded.group_name,generation=excluded.generation
`);

export function importBatch(sourceId: number, items: ImportItem[], generation: string): void {
  transaction(() => {
    for (const item of items) {
      const key = canonicalKey(item);
      const name = cleanTitle(item.title).replace(/^(?:UK|US|USA|EN)\s*[-:|]\s*/i, '').replace(/\s+(?:UHD|FHD|4K|HD|SD|1080P|720P)$/i, '').trim();
      const titleId = Number((upsertTitle.get(key, item.kind, name, item.year || null, item.season || null, item.episode || null, item.group || '', item.artwork || '') as { id: number }).id);
      upsertVariant.run(titleId, sourceId, item.sourceRef, secrets.seal(item.url, true), item.quality || '', item.group || '', generation);
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

export function listTitles(kind: MediaKind | 'all' | 'library', userId: number, query = ''): unknown[] {
  const search = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT t.id,t.kind,t.title,t.year,t.season,t.episode,t.group_name,t.artwork,
      COUNT(v.id) AS source_count,
      CASE WHEN f.title_id IS NULL THEN 0 ELSE 1 END AS favourite,
      p.position_seconds
    FROM titles t JOIN variants v ON v.title_id=t.id AND v.series_parent_id IS NULL
    LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE (?='all' OR (?='library' AND t.kind<>'channel') OR t.kind=?) AND t.title LIKE ? ESCAPE '\\'
    GROUP BY t.id ORDER BY t.title COLLATE NOCASE LIMIT 250
  `).all(userId, userId, kind, kind, kind, search);
}

export function titleExists(id: number): boolean {
  return !!db.prepare('SELECT id FROM titles WHERE id=?').get(id);
}

export function getTitle(id: number): { id: number; title: string; kind: MediaKind; year: number | null } | undefined {
  return db.prepare('SELECT id,title,kind,year FROM titles WHERE id=?').get(id) as { id:number; title:string; kind:MediaKind; year:number|null } | undefined;
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
      const titleId = Number((upsertTitle.get(canonicalKey(item), 'episode', cleanTitle(item.title), item.year || null, item.season || null, item.episode || null, item.group || '', item.artwork || '') as {id:number}).id);
      upsertEpisodeVariant.run(titleId,sourceId,item.sourceRef,secrets.seal(item.url,true),item.quality || '',item.group || '',generation,seriesId,(item.episodeName || '').slice(0,250));
    }
    db.prepare('DELETE FROM variants WHERE series_parent_id=? AND source_id=? AND generation<>?').run(seriesId,sourceId,generation);
  });
}

export function listSeriesEpisodes(seriesId: number, userId: number): unknown[] {
  return db.prepare(`
    SELECT t.id,t.kind,t.title,t.year,t.season,t.episode,t.group_name,MAX(v.episode_name) AS episode_name,
      COUNT(v.id) AS source_count,
      CASE WHEN f.title_id IS NULL THEN 0 ELSE 1 END AS favourite,p.position_seconds
    FROM variants v JOIN titles t ON t.id=v.title_id
    LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE v.series_parent_id=? GROUP BY t.id
    ORDER BY t.season DESC,t.episode DESC,t.id DESC LIMIT 1000
  `).all(userId,userId,seriesId);
}

export interface VariantRow { id: number; title_id: number; source_id: number; source_name: string; source_type: string; source_location: string; url: string; quality: string; group_name: string }

export function listVariants(titleId: number): VariantRow[] {
  const rows = db.prepare(`SELECT v.id,v.title_id,v.source_id,s.name AS source_name,s.type AS source_type,s.location AS source_location,v.url,v.quality,v.group_name
    FROM variants v JOIN sources s ON s.id=v.source_id WHERE v.title_id=? ORDER BY CASE WHEN v.quality IN ('4K','UHD') THEN 0 WHEN v.quality IN ('FHD','1080P') THEN 1 WHEN v.quality='HD' THEN 2 ELSE 3 END, s.id`)
    .all(titleId) as unknown as VariantRow[];
  return rows.map(v => ({ ...v, url: secrets.open(v.url), source_location: secrets.open(v.source_location) }));
}

export function getVariant(id: number): VariantRow | undefined {
  const variant = db.prepare(`SELECT v.id,v.title_id,v.source_id,s.name AS source_name,s.type AS source_type,s.location AS source_location,v.url,v.quality,v.group_name
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

export function dashboardStats(): { items: number; channels: number; sources: number } {
  const items = Number((db.prepare("SELECT COUNT(*) AS total FROM titles WHERE kind<>'channel' AND EXISTS (SELECT 1 FROM variants WHERE title_id=titles.id)").get() as { total: number }).total);
  const channels = Number((db.prepare("SELECT COUNT(*) AS total FROM titles WHERE kind='channel' AND EXISTS (SELECT 1 FROM variants WHERE title_id=titles.id)").get() as { total: number }).total);
  return { items, channels, sources: listSources().length };
}
