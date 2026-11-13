import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Duplex, PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Zip, ZipPassThrough } from 'fflate';
import type { Env } from '../../common/config/env.validation.js';
import { overlaps } from '../../common/fs/is-inside.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { onAbort } from '../abort-cleanup.js';
import { backupKey, createEncryptStream, keyId } from './backup-crypto.js';
import {
  type BackupManifest,
  backupName,
  CIPHER,
  DB_FILE,
  MANIFEST_FILE,
  type ManifestFile,
  PARTIAL_PREFIX,
  selectForRemoval,
  STORAGE_FILE,
  storedName,
} from './manifest.js';
import { allOrFirstError, dbTarget, runTool, withOptionFile } from './mysql-tools.js';

/** A backup holds every tenant's data: only this account may read it. */
export const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** The lock held while a backup runs (a file in BACKUP_DIR; rotation only looks at folders). */
export const LOCK_FILE = '.backup.lock';
/** A lock older than this is from a killed run: taken over once. */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;
/** A verify's scratch folder (one per run, holding its credentials file) gets this prefix. */
export const VERIFY_SCRATCH_PREFIX = '.verify-';
/** The credentials file of mysqldump / mysql (backup-verify and backup write one each). */
const CREDENTIALS_FILE = /^\.erp-db-.*\.cnf$/;
/** Younger than this, a credentials file or scratch folder may belong to a verify still running. */
const LEFTOVER_MS = 6 * 60 * 60 * 1000;

export interface BackupRun {
  folder: string;
  files: ManifestFile[];
  storageFiles: number;
  /** Folders deleted by the rotation (BACKUP_KEEP_DAYS). */
  removed: string[];
  /** Leftovers of killed runs removed at the start (see sweepStale). */
  swept: string[];
  ms: number;
}

/**
 * Removes what killed runs left in BACKUP_DIR: credentials files and verify
 * scratch folders older than six hours, and, when `partials` is set, every
 * partial backup folder. Only a run that holds `.backup.lock` may pass
 * `partials`: no other backup can be writing one then. Returns the names removed.
 */
export async function sweepStale(root: string, now: Date, partials: boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  const swept: string[] = [];
  for (const entry of entries) {
    const isPartial = partials && entry.isDirectory() && entry.name.startsWith(PARTIAL_PREFIX);
    const isLeftover =
      (entry.isFile() && CREDENTIALS_FILE.test(entry.name)) || (entry.isDirectory() && entry.name.startsWith(VERIFY_SCRATCH_PREFIX));
    if (!isPartial && !isLeftover) continue;
    const file = path.join(root, entry.name);
    if (!isPartial) {
      const info = await stat(file).catch(() => null);
      if (!info || now.getTime() - info.mtimeMs <= LEFTOVER_MS) continue;
    }
    await rm(file, { recursive: true, force: true });
    swept.push(entry.name);
  }
  return swept;
}

/**
 * The daily backup (ADR-010 §10.2, BUILD_PLAN §14-10), a Cron command:
 * the whole database (mysqldump, one consistent snapshot) and the uploaded
 * files, with a manifest of sha256 checksums, into one folder. Each file is
 * encrypted with BACKUP_ENCRYPTION_KEY when it is set (production requires
 * it). Only one backup runs at a time. A run that fails leaves nothing
 * behind; then old backups are rotated out.
 * systemPrisma: the whole database across tenants (allowed in `jobs`).
 */
@Injectable()
export class BackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The resolved BACKUP_DIR, refused when it would end up inside the uploads or the public web folder. */
  backupRoot(): string {
    const root = path.resolve(this.config.get('BACKUP_DIR', { infer: true }));
    const storage = path.resolve(this.config.get('STORAGE_DIR', { infer: true }));
    const web = this.config.get('WEB_DIST_DIR', { infer: true });
    if (overlaps(root, storage)) {
      throw new Error(`BACKUP_DIR ${root} overlaps STORAGE_DIR ${storage}`);
    }
    if (web && overlaps(root, path.resolve(web))) {
      throw new Error(`BACKUP_DIR ${root} overlaps WEB_DIST_DIR: backups would be public`);
    }
    return root;
  }

  async run(now = new Date()): Promise<BackupRun> {
    const started = Date.now();
    const root = this.backupRoot();
    // Every tenant's data: readable by this account only (folders 0700, files 0600).
    await mkdir(root, { recursive: true, mode: PRIVATE_DIR });
    const lock = await acquireLock(root, now);
    // An interrupt releases the lock too: a killed run must not hold the next one off for six hours.
    const unregister = onAbort(() => rm(lock, { force: true }));
    try {
      return await this.backupLocked(root, now, started);
    } finally {
      unregister();
      await rm(lock, { force: true });
    }
  }

  private async backupLocked(root: string, now: Date, started: number): Promise<BackupRun> {
    // The lock is held: no other backup runs, so every partial folder is a killed run's.
    const swept = await sweepStale(root, now, true);
    const name = backupName(now);
    const folder = path.join(root, name);
    if (existsSync(folder)) throw new Error(`${folder} already exists`);
    const partial = path.join(root, `${PARTIAL_PREFIX}${name}`);
    // Not recursive: a second run in the same second fails here instead of
    // writing into this one's files (and leaves them alone: outside the try).
    await mkdir(partial, { mode: PRIVATE_DIR });
    // An interrupt removes the partial folder, which holds the credentials file while the dump runs.
    const unregister = onAbort(() => rm(partial, { recursive: true, force: true }));

    const key = backupKey(this.config.get('BACKUP_ENCRYPTION_KEY', { infer: true }));
    let files: ManifestFile[];
    let storageFiles: number;
    try {
      const database = await this.dumpDatabase(partial, key);
      const storage = await this.zipStorage(partial, key);
      files = [database, storage.file];
      storageFiles = storage.count;

      const db = this.prisma.client;
      const [server] = await db.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
      const migrations = await db.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name`;
      const manifest: BackupManifest = {
        format: 2,
        name,
        createdAt: now.toISOString(),
        database: { name: dbTarget(this.config.get('DATABASE_URL', { infer: true })).database, server: server.version },
        migrations: { count: migrations.length, last: migrations.at(-1)?.migration_name ?? null },
        storage: { files: storageFiles },
        encryption: key ? { algorithm: CIPHER, keyId: keyId(key) } : null,
        files,
      };
      await writeFile(path.join(partial, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: PRIVATE_FILE });
      // Only a complete backup gets its real name.
      await rename(partial, folder);
    } catch (err) {
      await rm(partial, { recursive: true, force: true });
      throw err;
    } finally {
      unregister();
    }

    const removed = await this.rotate(root, now);
    return { folder, files, storageFiles, removed, swept, ms: Date.now() - started };
  }

  /** mysqldump → gzip → (encrypt) → file, hashing the bytes that reach the disk. */
  private async dumpDatabase(dir: string, key: Buffer | null): Promise<ManifestFile> {
    const target = dbTarget(this.config.get('DATABASE_URL', { infer: true }));
    const bin = this.config.get('MYSQLDUMP_PATH', { infer: true });
    const stored = storedName(DB_FILE, key !== null);
    return withOptionFile(
      target,
      async (options) => {
        const { done, stdout } = runTool(bin, [
          // Must come first: the credentials, never on the command line.
          `--defaults-extra-file=${options}`,
          // One consistent InnoDB snapshot without locking the tables.
          '--single-transaction',
          '--quick',
          '--hex-blob',
          '--default-character-set=utf8mb4',
          '--no-tablespaces',
          target.database,
        ]);
        const out = openStoredFile(path.join(dir, stored), key, DB_FILE);
        await allOrFirstError([done, pipeline(stdout, createGzip(), out.enc, out.tap, out.file)]);
        return { name: stored, ...out.summary() };
      },
      dir,
    );
  }

  /**
   * Every uploaded file (STORAGE_DIR), by its key, in one zip, streamed: each
   * file is read as the archive is written, so memory stays flat however
   * large the uploads grow. Stored, not compressed: logos are compressed already.
   */
  private async zipStorage(dir: string, key: Buffer | null): Promise<{ file: ManifestFile; count: number }> {
    const root = path.resolve(this.config.get('STORAGE_DIR', { infer: true }));
    const files: string[] = [];
    if (existsSync(root)) {
      for (const d of await readdir(root, { recursive: true, withFileTypes: true })) {
        // Skip preflight's write probe if it is ever caught mid-check.
        if (!d.isFile() || d.name.startsWith('.preflight-')) continue;
        files.push(path.join(d.parentPath, d.name));
      }
    }
    files.sort();
    const stored = storedName(STORAGE_FILE, key !== null);
    const out = openStoredFile(path.join(dir, stored), key, STORAGE_FILE);
    await pipeline(Readable.from(zipEntries(root, files)), out.enc, out.tap, out.file);
    return { file: { name: stored, ...out.summary() }, count: files.length };
  }

  private async rotate(root: string, now: Date): Promise<string[]> {
    const names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    const doomed = selectForRemoval(names, now, this.config.get('BACKUP_KEEP_DAYS', { infer: true }));
    for (const name of doomed) await rm(path.join(root, name), { recursive: true, force: true });
    return doomed;
  }
}

/**
 * Takes the backup lock: `.backup.lock`, created exclusively. A lock held by
 * another run is refused; one older than STALE_LOCK_MS (a killed run) is
 * taken over once. Returns the lock's path, which the caller removes.
 */
async function acquireLock(root: string, now: Date): Promise<string> {
  const lock = path.join(root, LOCK_FILE);
  const body = JSON.stringify({ pid: process.pid, startedAt: now.toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lock, body, { flag: 'wx', mode: PRIVATE_FILE });
      return lock;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const info = await stat(lock).catch(() => null);
      if (!info) continue; // released meanwhile: try again
      if (attempt === 0 && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      const since = await readFile(lock, 'utf8')
        .then((text) => (JSON.parse(text) as { startedAt?: string }).startedAt ?? info.mtime.toISOString())
        .catch(() => info.mtime.toISOString());
      throw new Error(`Another backup is running (lock ${lock} since ${since})`, { cause: err });
    }
  }
  throw new Error(`Cannot take the backup lock in ${root}`);
}

interface StoredFile {
  /** The plaintext enters here: encrypted when a key is set, otherwise passed through. */
  enc: Duplex;
  /** Hashes and counts the bytes that reach the disk. */
  tap: Transform;
  file: WriteStream;
  /** Size and sha256 of what was written: call once, after the pipeline has finished. */
  summary: () => { bytes: number; sha256: string };
}

function openStoredFile(file: string, key: Buffer | null, aad: string): StoredFile {
  const hash = createHash('sha256');
  let bytes = 0;
  const enc: Duplex = key ? createEncryptStream(key, aad) : new PassThrough();
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  return {
    enc,
    tap,
    file: createWriteStream(file, { mode: PRIVATE_FILE }),
    summary: () => ({ bytes, sha256: hash.digest('hex') }),
  };
}

/**
 * The zip of `files`, produced as each file is read. Backpressure comes from
 * the pipeline pulling this generator: a file is read only when the disk
 * has taken what was written before.
 */
async function* zipEntries(root: string, files: string[]): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = [];
  const state: { failure: unknown } = { failure: null };
  const zip = new Zip((err, data) => {
    if (err) state.failure = err;
    else if (data.length > 0) out.push(data);
  });
  for (const file of files) {
    const entry = new ZipPassThrough(path.relative(root, file).split(path.sep).join('/'));
    zip.add(entry);
    for await (const chunk of createReadStream(file)) {
      entry.push(chunk as Uint8Array, false);
      yield* out.splice(0);
      if (state.failure) throw state.failure;
    }
    entry.push(new Uint8Array(0), true);
    yield* out.splice(0);
  }
  zip.end();
  yield* out.splice(0);
  if (state.failure) throw state.failure;
}
