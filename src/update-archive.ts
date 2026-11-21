import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { createGunzip } from 'node:zlib';

export interface ExpectedFile { path: string; sha: string; size: number }

export function managedFile(path: string): boolean {
  return path === 'package.json' || path === 'README.md' ||
    (path.startsWith('src/') && path.endsWith('.ts')) ||
    (path.startsWith('web/') && !path.endsWith('/'));
}

/** Accept regular files only. Never follow paths, links or archive permissions from a remote archive. */
function safePath(path: string): string {
  if (path.length > 300 || path.includes('\\') || path.includes('\0') || path.startsWith('/')) throw new Error('Archive contains an unsafe path.');
  const parts = path.split('/');
  if (parts.length < 2 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Archive contains a traversal path.');
  const relative = parts.slice(1).join('/');
  if (!relative || posix.normalize(relative) !== relative || relative.startsWith('../')) throw new Error('Archive contains an unsafe member.');
  return relative;
}

function tarText(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return field.subarray(0, zero < 0 ? field.length : zero).toString('utf8');
}

function tarNumber(header: Buffer, offset: number, length: number): number {
  const value = tarText(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Archive has an unsupported TAR number.');
  const parsed = parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Archive member size is invalid.');
  return parsed;
}

function paxName(payload: Buffer): string | undefined {
  let offset = 0;
  let name: string | undefined;
  while (offset < payload.length) {
    const space = payload.indexOf(32, offset);
    if (space < 0) throw new Error('Malformed PAX archive extension.');
    const length = Number(payload.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length < 4 || offset + length > payload.length) throw new Error('Malformed PAX archive record.');
    const record = payload.subarray(space + 1, offset + length - 1).toString('utf8');
    if (record.startsWith('path=')) name = record.slice(5);
    offset += length;
  }
  return name;
}

/** Bounded streaming TAR reader: one member at a time, never a whole decompressed archive. */
export async function extractVerifiedArchive(archivePath: string, stagingRoot: string, expected: ExpectedFile[]): Promise<void> {
  if (!expected.length || expected.length > 300) throw new Error('Update has an unexpected file count.');
  const files = new Map(expected.map(file => [file.path, file]));
  const seen = new Set<string>();
  const gzip = createReadStream(archivePath).pipe(createGunzip());
  const iterator = gzip[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);
  let total = 0;
  async function take(count: number): Promise<Buffer> {
    if (count < 0 || count > 16 * 1024 * 1024) throw new Error('Update archive member exceeds the size limit.');
    const chunks: Buffer[] = [];
    let remaining = count;
    while (remaining) {
      if (!buffered.length) {
        const next = await iterator.next();
        if (next.done) throw new Error('Update archive ended unexpectedly.');
        buffered = Buffer.from(next.value);
      }
      const amount = Math.min(remaining, buffered.length);
      chunks.push(buffered.subarray(0, amount));
      buffered = buffered.subarray(amount);
      remaining -= amount;
      total += amount;
      if (total > 64 * 1024 * 1024) throw new Error('Update archive exceeds the expanded size limit.');
    }
    return Buffer.concat(chunks, count);
  }
  let nextPath: string | undefined;
  let finished = false;
  try {
    for (let entry = 0; entry < 500; entry++) {
      const header = await take(512);
      if (header.every(byte => byte === 0)) { finished = true; break; }
      const checksum = tarNumber(header, 148, 8);
      const copy = Buffer.from(header);
      copy.fill(32, 148, 156);
      if (copy.reduce((sum, byte) => sum + byte, 0) !== checksum) throw new Error('Update TAR header checksum failed.');
      const prefix = tarText(header, 345, 155);
      const originalName = tarText(header, 0, 100);
      const name = nextPath || (prefix ? prefix + '/' + originalName : originalName);
      nextPath = undefined;
      const type = String.fromCharCode(header[156]);
      const size = tarNumber(header, 124, 12);
      if (size > 16 * 1024 * 1024) throw new Error('Update contains an oversized file.');
      const content = await take(size);
      const padding = (512 - size % 512) % 512;
      if (padding) await take(padding);
      if (type === 'g') continue;
      if (type === 'x' || type === 'L') {
        nextPath = type === 'x' ? paxName(content) : content.toString('utf8').replace(/\0.*$/s, '').trimEnd();
        continue;
      }
      if (type === '5') continue;
      if (type !== '0' && type !== '\0') throw new Error('Update archive contains a link or unsupported file.');
      const path = safePath(name);
      if (!managedFile(path)) continue;
      const file = files.get(path);
      if (!file || seen.has(path) || file.size !== content.length) throw new Error('Update files do not match the GitHub commit.');
      const gitHash = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
      if (gitHash !== file.sha) throw new Error('Update file integrity check failed.');
      const destination = join(stagingRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { mode: 0o644, flag: 'wx' });
      seen.add(path);
    }
  } finally {
    gzip.destroy();
  }
  if (!finished || seen.size !== files.size) throw new Error('Update archive is incomplete.');
  for (const required of ['package.json', 'src/server.ts', 'src/update-worker.ts', 'src/updater.ts', 'src/update-archive.ts', 'web/app.js', 'web/index.html', 'web/styles.css', 'web/sw.js']) {
    if (!seen.has(required)) throw new Error(`Update is missing ${required}.`);
  }
  const manifest = JSON.parse(await readFile(join(stagingRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (manifest.name !== 'hearthwave' || !/^\d+\.\d+\.\d+$/.test(manifest.version || '')) throw new Error('Update has an invalid Hearthwave package manifest.');
  const size = (await stat(join(stagingRoot, 'src/server.ts'))).size;
  if (size < 1000) throw new Error('Update server entrypoint is incomplete.');
}
