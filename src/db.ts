import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { canonicalKey, cleanTitle } from './catalogue.ts';
import { secretStore } from './secrets.ts';
import type { ImportItem, MediaKind, SourceInput, User } from './model.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.HEARTHWAVE_DATA_DIR || join(packageRoot, 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
try { chmodSync(dataDir, 0o700); } catch { /* Some NAS file systems do not implement POSIX permissions. */ }
const secrets = secretStore(dataDir);

export const db = new DatabaseSync(join(dataDir, 'hearthwave.sqlite'), { enableForeignKeyConstraints: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;');
const schemaVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
if (schemaVersion > 1) throw new Error(`Database schema ${schemaVersion} requires a newer Hearthwave version.`);
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
if (schemaVersion === 0) db.exec('PRAGMA user_version = 1;');
db.prepare("UPDATE sources SET status='interrupted',last_error='Previous scan was interrupted; run it again.' WHERE status='scanning'").run();

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

export interface SourceRow { id: number; name: string; type: SourceInput['type']; location: string; status: string; last_import: string | null; last_error: string | null }

export function listSources(): SourceRow[] {
  return (db.prepare('SELECT id,name,type,location,status,last_import,last_error FROM sources ORDER BY id').all() as unknown as SourceRow[])
    .map(source => ({ ...source, location: secrets.open(source.location) }));
}

export function getSource(id: number): SourceRow | undefined {
  const source = db.prepare('SELECT id,name,type,location,status,last_import,last_error FROM sources WHERE id=?').get(id) as SourceRow | undefined;
  return source ? { ...source, location: secrets.open(source.location) } : undefined;
}

export function addSource(input: SourceInput): SourceRow {
  const result = db.prepare('INSERT INTO sources (name,type,location) VALUES (?,?,?)').run(input.name, input.type, secrets.seal(input.location || ''));
  return getSource(Number(result.lastInsertRowid))!;
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
      upsertVariant.run(titleId, sourceId, item.sourceRef, secrets.seal(item.url), item.quality || '', item.group || '', generation);
    }
  });
}

export function completeImport(sourceId: number, generation: string): void {
  transaction(() => {
    db.prepare('DELETE FROM variants WHERE source_id=? AND generation<>?').run(sourceId, generation);
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
    FROM titles t JOIN variants v ON v.title_id=t.id
    LEFT JOIN favourites f ON f.title_id=t.id AND f.user_id=?
    LEFT JOIN progress p ON p.title_id=t.id AND p.user_id=?
    WHERE (?='all' OR (?='library' AND t.kind<>'channel') OR t.kind=?) AND t.title LIKE ? ESCAPE '\\'
    GROUP BY t.id ORDER BY t.title COLLATE NOCASE LIMIT 250
  `).all(userId, userId, kind, kind, kind, search);
}

export function titleExists(id: number): boolean {
  return !!db.prepare('SELECT id FROM titles WHERE id=?').get(id);
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
