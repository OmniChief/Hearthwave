import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import { dataDir, db } from './db.ts';

export class BackupError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

let active = false;
export function backupBusy(): boolean { return active; }

type ArchiveMember = { name: string; size: number; file?: string; content?: Buffer };

function octal(header: Buffer, offset: number, width: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value.toString(8).length > width - 1) throw new Error('Backup archive exceeds the TAR format limit.');
  header.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'ascii');
}

function tarHeader(member: ArchiveMember, when: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(member.name, 0, 100, 'utf8');
  octal(header, 100, 8, 0o600);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, member.size);
  octal(header, 136, 12, when);
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  octal(header, 148, 8, checksum);
  return header;
}

async function* archive(members: ArchiveMember[], when: number): AsyncGenerator<Buffer> {
  for (const member of members) {
    yield tarHeader(member, when);
    if (member.file) {
      for await (const chunk of createReadStream(member.file, { highWaterMark: 64 * 1024 })) yield chunk as Buffer;
    } else if (member.content) yield member.content;
    const padding = (512 - member.size % 512) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

/** Export a WAL-consistent SQLite snapshot, not a copy of the live database file. */
export async function streamBackup(res: ServerResponse): Promise<void> {
  if (active) throw new BackupError(409, 'Another backup is already running.');
  active = true;
  let temporary: string | undefined;
  try {
    const databasePath = join(dataDir, 'hearthwave.sqlite');
    const keyPath = join(dataDir, 'secret.key');
    const [databaseInfo, space, key] = await Promise.all([stat(databasePath), statfs(dataDir), readFile(keyPath)]);
    if (key.length !== 32) throw new BackupError(500, 'The encryption key is invalid.');
    if (space.bavail * space.bsize < databaseInfo.size + 8 * 1024 * 1024) {
      throw new BackupError(507, 'Insufficient free space for a safe database snapshot.');
    }
    temporary = await mkdtemp(join(dataDir, '.hearthwave-backup-'));
    await chmod(temporary, 0o700).catch(() => {});
    const snapshot = join(temporary, 'hearthwave.sqlite');
    await backup(db, snapshot);
    await chmod(snapshot, 0o600).catch(() => {});
    const size = (await stat(snapshot)).size;
    const now = new Date();
    const manifest = Buffer.from(JSON.stringify({
      format: 'hearthwave-backup', formatVersion: 1,
      createdAt: now.toISOString(), appVersion: '0.15.0',
      schemaVersion: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      files: ['hearthwave.sqlite', 'secret.key'],
    }, null, 2) + '\n');
    const members: ArchiveMember[] = [
      { name: 'manifest.json', content: manifest, size: manifest.length },
      { name: 'hearthwave.sqlite', file: snapshot, size },
      { name: 'secret.key', content: key, size: key.length },
    ];
    const filename = `hearthwave-backup-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.tar.gz`;
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(Readable.from(archive(members, Math.floor(now.getTime() / 1000))), createGzip({ level: 1 }), res);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    active = false;
  }
}
