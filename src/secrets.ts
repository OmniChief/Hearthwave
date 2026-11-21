import { openSync, readFileSync, writeSync, closeSync, chmodSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Protect credential-bearing provider URLs in database-only exports. Keep this key with backups. */
export function secretStore(dataDirectory: string): { seal: (value: string, always?: boolean) => string; open: (value: string) => string } {
  const path = join(dataDirectory, 'secret.key');
  let key: Buffer;
  try { key = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const generated = randomBytes(32);
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, generated); } finally { closeSync(fd); }
      key = generated;
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
      key = readFileSync(path);
    }
  }
  if (key.length !== 32) throw new Error('The data directory secret.key is invalid. Restore the original key from backup.');
  try { chmodSync(path, 0o600); } catch { /* Keep running on file systems without chmod. */ }
  return {
    seal(value, always = false) {
      if (!always && !/^https?:/i.test(value)) return value;
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `enc:v1:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
    },
    open(value) {
      if (!value.startsWith('enc:v1:')) return value;
      const fields = value.split(':');
      if (fields.length !== 5) throw new Error('Encrypted provider URL is damaged.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(fields[2], 'base64url'));
      decipher.setAuthTag(Buffer.from(fields[3], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(fields[4], 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
