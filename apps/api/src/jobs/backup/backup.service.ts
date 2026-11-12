import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { zipSync } from 'fflate';
import type { Env } from '../../common/config/env.validation.js';
import { overlaps } from '../../common/fs/is-inside.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  type BackupManifest,
  backupName,
  DB_FILE,
  MANIFEST_FILE,
  type ManifestFile,
  PARTIAL_PREFIX,
  selectForRemoval,
  sha256File,
  STORAGE_FILE,
} from './manifest.js';
import { allOrFirstError, dbTarget, runTool, withOptionFile } from './mysql-tools.js';

/** A backup holds every tenant's data: only this account may read it. */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

export interface BackupRun {
  folder: string;
  files: ManifestFile[];
  storageFiles: number;
  /** Folders deleted by the rotation (BACKUP_KEEP_DAYS). */
  removed: string[];
  ms: number;
}

/**
 * The daily backup (ADR-010 §10.2, BUILD_PLAN §14-10), a Cron command:
 * the whole database (mysqldump, one consistent snapshot) and the uploaded
 * files, with a manifest of sha256 checksums, into one folder. A run that
 * fails leaves nothing behind; then old backups are rotated out.
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
    const name = backupName(now);
    const folder = path.join(root, name);
    if (existsSync(folder)) throw new Error(`${folder} already exists`);
    const partial = path.join(root, `${PARTIAL_PREFIX}${name}`);
    // Not recursive: a second run in the same second fails here instead of
    // writing into this one's files (and leaves them alone: outside the try).
    await mkdir(partial, { mode: PRIVATE_DIR });

    let files: ManifestFile[];
    let storageFiles: number;
    try {
      const database = await this.dumpDatabase(path.join(partial, DB_FILE));
      const storage = await this.zipStorage(path.join(partial, STORAGE_FILE));
      files = [database, storage.file];
      storageFiles = storage.count;

      const db = this.prisma.client;
      const [server] = await db.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
      const migrations = await db.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name`;
      const manifest: BackupManifest = {
        format: 1,
        name,
        createdAt: now.toISOString(),
        database: { name: dbTarget(this.config.get('DATABASE_URL', { infer: true })).database, server: server.version },
        migrations: { count: migrations.length, last: migrations.at(-1)?.migration_name ?? null },
        storage: { files: storageFiles },
        files,
      };
      await writeFile(path.join(partial, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: PRIVATE_FILE });
      // Only a complete backup gets its real name.
      await rename(partial, folder);
    } catch (err) {
      await rm(partial, { recursive: true, force: true });
      throw err;
    }

    const removed = await this.rotate(root, now);
    return { folder, files, storageFiles, removed, ms: Date.now() - started };
  }

  /** mysqldump → gzip → file, hashing the compressed bytes on the way. */
  private async dumpDatabase(file: string): Promise<ManifestFile> {
    const target = dbTarget(this.config.get('DATABASE_URL', { infer: true }));
    const bin = this.config.get('MYSQLDUMP_PATH', { infer: true });
    return withOptionFile(target, async (options) => {
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
      const hash = createHash('sha256');
      let bytes = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          bytes += chunk.length;
          cb(null, chunk);
        },
      });
      await allOrFirstError([done, pipeline(stdout, createGzip(), tap, createWriteStream(file, { mode: PRIVATE_FILE }))]);
      return { name: DB_FILE, bytes, sha256: hash.digest('hex') };
    });
  }

  /** Every uploaded file (STORAGE_DIR), by its key, in one zip. */
  private async zipStorage(file: string): Promise<{ file: ManifestFile; count: number }> {
    const root = path.resolve(this.config.get('STORAGE_DIR', { infer: true }));
    const entries: Record<string, Uint8Array> = {};
    if (existsSync(root)) {
      for (const d of await readdir(root, { recursive: true, withFileTypes: true })) {
        // Skip preflight's write probe if it is ever caught mid-check.
        if (!d.isFile() || d.name.startsWith('.preflight-')) continue;
        const full = path.join(d.parentPath, d.name);
        entries[path.relative(root, full).split(path.sep).join('/')] = await readFile(full);
      }
    }
    // Logos are PNG/JPEG already: storing them is as small as compressing them.
    const zipped = zipSync(entries, { level: 0 });
    await writeFile(file, zipped, { mode: PRIVATE_FILE });
    return {
      file: { name: STORAGE_FILE, bytes: zipped.length, sha256: await sha256File(file) },
      count: Object.keys(entries).length,
    };
  }

  private async rotate(root: string, now: Date): Promise<string[]> {
    const names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    const doomed = selectForRemoval(names, now, this.config.get('BACKUP_KEEP_DAYS', { infer: true }));
    for (const name of doomed) await rm(path.join(root, name), { recursive: true, force: true });
    return doomed;
  }
}
