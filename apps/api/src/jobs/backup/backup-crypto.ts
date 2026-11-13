import { parseKey32 } from '../../common/crypto/secret-box.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Encryption of backup files at rest (ADR-010 §10.2): AES-256-GCM with the
 * 32-byte BACKUP_ENCRYPTION_KEY. File layout:
 *   MAGIC (6 bytes, "ERPBK1") | IV (12 random bytes) | ciphertext | tag (16 bytes)
 * The logical file name (e.g. "database.sql.gz") is the additional
 * authenticated data, so a file cannot pass for another file of the same
 * backup. A wrong key, a changed byte or a wrong name fails to decrypt.
 */
export const MAGIC = Buffer.from('ERPBK1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;
const ALGORITHM = 'aes-256-gcm' as const;

/**
 * The key from BACKUP_ENCRYPTION_KEY (base64), or null when unset (development
 * only: production refuses to start without it). Throws when it is set but
 * is not 32 bytes. The key itself is never logged or stored.
 */
export function backupKey(base64: string | undefined): Buffer | null {
  if (base64 === undefined || base64 === '') return null;
  // The same parsing the config schema validates with (isSealingKey).
  return parseKey32(base64, 'BACKUP_ENCRYPTION_KEY');
}

/** A public fingerprint of the key (first 16 hex chars of its sha256), saved in the manifest. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Why `key` cannot open a backup made with `backupKeyId`, or null when it can.
 * Used by backup-verify and backup-decrypt, with the same wording.
 */
export function keyProblem(backupKeyId: string, key: Buffer | null): string | null {
  if (key === null) return 'this backup is encrypted: set BACKUP_ENCRYPTION_KEY';
  const current = keyId(key);
  if (current !== backupKeyId) {
    return `BACKUP_ENCRYPTION_KEY is not the key this backup was made with (key id ${current}, backup ${backupKeyId})`;
  }
  return null;
}

/**
 * A transform that encrypts what is written to it: MAGIC and IV first, then
 * the ciphertext, then the tag at the end. Pipe the plaintext in, the file out.
 */
export function createEncryptStream(key: Buffer, aad: string): Transform {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!headerSent) {
        headerSent = true;
        this.push(Buffer.concat([MAGIC, iv]));
      }
      const out = cipher.update(chunk);
      if (out.length > 0) this.push(out);
      cb();
    },
    flush(cb) {
      if (!headerSent) {
        headerSent = true;
        this.push(Buffer.concat([MAGIC, iv]));
      }
      try {
        const last = cipher.final();
        if (last.length > 0) this.push(last);
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/**
 * Opens an encrypted backup file for reading the plaintext. The header and
 * the tag are read first and the tag is set before any byte is decrypted,
 * so a wrong key, a wrong name or a changed byte makes the stream fail with
 * 'Unsupported state or unable to authenticate data' at its end.
 */
export async function createDecryptStream(file: string, key: Buffer, aad: string): Promise<Readable> {
  const fh: FileHandle = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const name = path.basename(file);
    if (size < HEADER_BYTES + TAG_BYTES) throw new Error(`${name} is not an encrypted backup file (too short)`);
    const header = await readAt(fh, HEADER_BYTES, 0, name);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error(`${name} is not an encrypted backup file (bad header)`);
    }
    const iv = header.subarray(MAGIC.length);
    const tag = await readAt(fh, TAG_BYTES, size - TAG_BYTES, name);
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const cipherEnd = size - TAG_BYTES; // exclusive
    const source =
      cipherEnd > HEADER_BYTES
        ? createReadStream(file, { start: HEADER_BYTES, end: cipherEnd - 1 })
        : Readable.from([]);
    // pipeline destroys decipher with the error, so whoever reads it sees it; the promise itself is not needed.
    pipeline(source, decipher).catch(() => undefined);
    return decipher;
  } finally {
    await fh.close();
  }
}

/** The whole plaintext of an encrypted backup file (small files only: the storage zip). */
export async function decryptFileToBuffer(file: string, key: Buffer, aad: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await createDecryptStream(file, key, aad)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readAt(fh: FileHandle, length: number, position: number, name: string): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead !== length) throw new Error(`${name} is truncated`);
  return buf;
}
