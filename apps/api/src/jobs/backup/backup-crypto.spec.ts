import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import {
  backupKey,
  createDecryptStream,
  createEncryptStream,
  decryptFileToBuffer,
  keyId,
  keyProblem,
  MAGIC,
} from './backup-crypto.js';

const MB = 1024 * 1024;

describe('backup encryption (ADR-010 §10.2)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'backup-crypto-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Encrypts `data` into a file named `name` in the scratch folder, through the real stream. */
  async function encryptToFile(data: Buffer, key: Buffer, aad: string, name: string): Promise<string> {
    const file = path.join(dir, name);
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from(splitInto(data, 64 * 1024)),
      createEncryptStream(key, aad),
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      }),
    );
    writeFileSync(file, Buffer.concat(chunks));
    return file;
  }

  function splitInto(data: Buffer, size: number): Buffer[] {
    const parts: Buffer[] = [];
    for (let i = 0; i < data.length; i += size) parts.push(data.subarray(i, i + size));
    return parts;
  }

  /** Reads the whole plaintext from a file, or rejects with the stream error. */
  const decrypt = (file: string, key: Buffer, aad: string) => decryptFileToBuffer(file, key, aad);

  it('round-trips 1 MB of random data, and the file starts with the magic and the IV', async () => {
    const key = randomBytes(32);
    const data = randomBytes(1 * MB);
    const file = await encryptToFile(data, key, 'database.sql.gz', 'round.bin');
    const raw = readFileSync(file);
    expect(raw.subarray(0, MAGIC.length).equals(Buffer.from('ERPBK1'))).toBe(true);
    expect(raw.length).toBe(6 + 12 + data.length + 16);
    expect((await decrypt(file, key, 'database.sql.gz')).equals(data)).toBe(true);
  });

  it('round-trips an empty file', async () => {
    const key = randomBytes(32);
    const file = await encryptToFile(Buffer.alloc(0), key, 'storage.zip', 'empty.bin');
    expect(readFileSync(file).length).toBe(6 + 12 + 16);
    expect((await decrypt(file, key, 'storage.zip')).length).toBe(0);
  });

  it('fails with a wrong key', async () => {
    const file = await encryptToFile(randomBytes(4096), randomBytes(32), 'storage.zip', 'wrong-key.bin');
    await expect(decrypt(file, randomBytes(32), 'storage.zip')).rejects.toThrow(/unable to authenticate data/);
  });

  it('fails when one byte of the ciphertext is flipped', async () => {
    const key = randomBytes(32);
    const file = await encryptToFile(randomBytes(4096), key, 'storage.zip', 'flipped.bin');
    const raw = readFileSync(file);
    raw[6 + 12 + 100] ^= 0x01;
    writeFileSync(file, raw);
    await expect(decrypt(file, key, 'storage.zip')).rejects.toThrow(/unable to authenticate data/);
  });

  it('fails when the tag is changed', async () => {
    const key = randomBytes(32);
    const file = await encryptToFile(randomBytes(4096), key, 'storage.zip', 'flipped-tag.bin');
    const raw = readFileSync(file);
    raw[raw.length - 1] ^= 0x80;
    writeFileSync(file, raw);
    await expect(decrypt(file, key, 'storage.zip')).rejects.toThrow(/unable to authenticate data/);
  });

  it('fails with another logical name: a file cannot pass for another file of the backup', async () => {
    const key = randomBytes(32);
    const file = await encryptToFile(randomBytes(4096), key, 'database.sql.gz', 'aad.bin');
    await expect(decrypt(file, key, 'storage.zip')).rejects.toThrow(/unable to authenticate data/);
  });

  it('fails with bad magic, and says so before reading the data', async () => {
    const key = randomBytes(32);
    const file = await encryptToFile(randomBytes(4096), key, 'storage.zip', 'magic.bin');
    const raw = readFileSync(file);
    raw.write('XXXXXX', 0, 'ascii');
    writeFileSync(file, raw);
    await expect(createDecryptStream(file, key, 'storage.zip')).rejects.toThrow(/bad header/);
  });

  it('fails on a file too short to hold a header and a tag', async () => {
    const file = path.join(dir, 'short.bin');
    writeFileSync(file, Buffer.from('ERPBK1'));
    await expect(createDecryptStream(file, randomBytes(32), 'storage.zip')).rejects.toThrow(/too short/);
  });

  it('reads the key from base64, refuses any other length, and fingerprints it without the key', () => {
    expect(backupKey(undefined)).toBeNull();
    expect(backupKey('')).toBeNull();
    const raw = randomBytes(32);
    expect(backupKey(raw.toString('base64'))?.equals(raw)).toBe(true);
    expect(() => backupKey(randomBytes(16).toString('base64'))).toThrow(/32 random bytes/);
    const id = keyId(raw);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain(raw.toString('base64'));
  });

  it('says why a key cannot open a backup, with the same words everywhere', () => {
    const key = randomBytes(32);
    const id = keyId(key);
    expect(keyProblem(id, key)).toBeNull();
    expect(keyProblem(id, null)).toBe('this backup is encrypted: set BACKUP_ENCRYPTION_KEY');
    const other = randomBytes(32);
    expect(keyProblem(id, other)).toBe(
      `BACKUP_ENCRYPTION_KEY is not the key this backup was made with (key id ${keyId(other)}, backup ${id})`,
    );
  });
});
