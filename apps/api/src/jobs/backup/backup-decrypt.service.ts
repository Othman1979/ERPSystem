import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env.validation.js';
import { isInside, overlaps } from '../../common/fs/is-inside.js';
import { backupKey, createDecryptStream, keyProblem } from './backup-crypto.js';
import {
  type BackupManifest,
  DB_FILE,
  encryptionOf,
  MANIFEST_FILE,
  resolveBackupFolder,
  sha256File,
  STORAGE_FILE,
  storedName,
} from './manifest.js';

export interface DecryptResult {
  folder: string;
  outDir: string;
  /** The plaintext files written, by their logical names. */
  files: string[];
}

/**
 * Disaster recovery without the application (docs/runbooks/backup-restore.md):
 * decrypts an encrypted backup folder into a new folder, as the plaintext
 * `database.sql.gz` and `storage.zip` (the gzip stays compressed: gunzip it
 * when loading), with a copy of the manifest. Run by hand:
 *   node dist/jobs/cli.js backup-decrypt <folder|latest> <outdir>
 * The output holds every tenant's data in clear: it is created 0700 and
 * refused inside the uploads, the public web folder, or BACKUP_DIR (or
 * containing it). A failed run removes it.
 * Each stored file's checksum is checked first; the AES-GCM tag checks the rest.
 */
@Injectable()
export class BackupDecryptService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async run(which: string, outDir: string): Promise<DecryptResult> {
    const root = path.resolve(this.config.get('BACKUP_DIR', { infer: true }));
    const folder = await resolveBackupFolder(which, root);
    const manifest = JSON.parse(await readFile(path.join(folder, MANIFEST_FILE), 'utf8')) as BackupManifest;
    const format: unknown = manifest.format; // read as unknown: a file from anywhere may hold any value
    if (format !== 1 && format !== 2) {
      throw new Error(`Unknown manifest format ${String(format)}`);
    }
    const enc = encryptionOf(manifest);
    if (!enc) throw new Error(`${folder} is not encrypted: its files can be used as they are`);

    const key = backupKey(this.config.get('BACKUP_ENCRYPTION_KEY', { infer: true }));
    const problem = keyProblem(enc.keyId, key);
    if (problem !== null || key === null) throw new Error(problem ?? 'BACKUP_ENCRYPTION_KEY is not set');

    // The output folder: never inside the uploads, the public web folder, or the backups (copied off the server).
    const out = path.resolve(outDir);
    const storage = path.resolve(this.config.get('STORAGE_DIR', { infer: true }));
    const web = this.config.get('WEB_DIST_DIR', { infer: true });
    if (isInside(out, storage)) throw new Error(`Refused: ${out} is inside STORAGE_DIR`);
    if (web && isInside(out, path.resolve(web))) throw new Error(`Refused: ${out} is inside WEB_DIST_DIR (public)`);
    if (overlaps(out, root)) {
      throw new Error(`Refused: ${out} is inside BACKUP_DIR (copied off the server; plaintext must not go there)`);
    }
    if (existsSync(out)) throw new Error(`${out} already exists: choose a new folder`);

    // The stored files must match the manifest before anything is decrypted.
    const damaged: string[] = [];
    for (const f of manifest.files) {
      const file = path.join(folder, f.name);
      const plainName = path.basename(f.name) === f.name;
      if (!plainName || !existsSync(file) || (await sha256File(file)) !== f.sha256) damaged.push(f.name);
    }
    if (damaged.length > 0) throw new Error(`Refused: damaged or missing in ${folder}: ${damaged.join(', ')}`);

    await mkdir(out, { mode: 0o700 });
    const written: string[] = [];
    try {
      for (const logical of [DB_FILE, STORAGE_FILE]) {
        const stored = path.join(folder, storedName(logical, true));
        const plain = path.join(out, logical);
        await pipeline(await createDecryptStream(stored, key, logical), createWriteStream(plain, { mode: 0o600 }));
        written.push(logical);
      }
      await copyFile(path.join(folder, MANIFEST_FILE), path.join(out, MANIFEST_FILE));
    } catch (err) {
      // Never leave half-decrypted data behind.
      await rm(out, { recursive: true, force: true });
      throw err;
    }
    return { folder, outDir: out, files: written };
  }
}
