import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unzipSync } from 'fflate';
import mariadb, { type Connection } from 'mariadb';
import type { Env } from '../../common/config/env.validation.js';
import { onAbort } from '../abort-cleanup.js';
import { PRIVATE_DIR, sweepStale, VERIFY_SCRATCH_PREFIX } from './backup.service.js';
import { backupKey, createDecryptStream, decryptFileToBuffer, keyProblem } from './backup-crypto.js';
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
import { dbTarget, type DbTarget, firstLine, runTool, sameDatabase, withOptionFile } from './mysql-tools.js';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  folder: string;
  /** The scratch database the backup was restored into. */
  restoredInto: string | null;
  kept: boolean;
  checks: VerifyCheck[];
  /** Leftovers of killed runs removed at the start (see sweepStale). */
  swept: string[];
}

/** A scratch database: its name says so, so a typo cannot point this at real data. */
const SCRATCH_NAME = /restore|verify/i;

/**
 * Proves a backup can be restored (ADR-010 §10.2, acceptance "a restore in a
 * test environment succeeds and is documented"):
 *  1. every file matches its manifest checksum;
 *  2. the dump is loaded into BACKUP_VERIFY_DATABASE_URL, a scratch database
 *     created once from the hosting panel (emptied before and after; never
 *     the live one; no CREATE / DROP DATABASE privilege needed);
 *  3. the restored data is checked: same migrations, every posted journal
 *     entry balanced, stock balances equal to the movements, every uploaded
 *     file referenced by the database present in the storage zip.
 * The scratch database is emptied afterwards unless `keep`.
 * Cross-tenant SQL on purpose: the whole restored copy is checked, through
 * the driver, outside the application (allowed in `jobs`).
 */
@Injectable()
export class BackupVerifyService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async run(which: string, keep = false): Promise<VerifyResult> {
    const root = path.resolve(this.config.get('BACKUP_DIR', { infer: true }));
    // No lock is taken by a verify, so only the leftovers of old killed runs are swept.
    const swept = await sweepStale(root, new Date(), false);
    const folder = await resolveBackupFolder(which, root);
    const checks: VerifyCheck[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const result = (restoredInto: string | null, kept: boolean): VerifyResult => ({
      ok: checks.every((c) => c.ok),
      folder,
      restoredInto,
      kept,
      checks,
      swept,
    });

    const manifest = JSON.parse(await readFile(path.join(folder, MANIFEST_FILE), 'utf8')) as BackupManifest;
    // 1: plaintext backups made before encryption; 2: current (encryption may be null).
    const format: unknown = manifest.format; // read as unknown: a file from anywhere may hold any value
    if (format !== 1 && format !== 2) {
      throw new Error(`Unknown manifest format ${String(format)}`);
    }

    // 1. Checksums: a damaged dump is not loaded at all.
    const damaged: string[] = [];
    for (const f of manifest.files) {
      const file = path.join(folder, f.name);
      if (!existsSync(file) || (await stat(file)).size !== f.bytes || (await sha256File(file)) !== f.sha256) {
        damaged.push(f.name);
      }
    }
    add('files', damaged.length === 0, damaged.length ? `damaged or missing: ${damaged.join(', ')}` : `${manifest.files.length} match the manifest`);
    if (damaged.length) return result(null, false);

    // 2. The key: an encrypted backup needs the key it was made with.
    const enc = encryptionOf(manifest);
    const key = backupKey(this.config.get('BACKUP_ENCRYPTION_KEY', { infer: true }));
    if (enc) {
      const problem = keyProblem(enc.keyId, key);
      add('key', problem === null, problem ?? `key id ${enc.keyId}`);
      if (problem) return result(null, false);
    }
    const dumpFile = path.join(folder, storedName(DB_FILE, enc !== null));
    const storageFile = path.join(folder, storedName(STORAGE_FILE, enc !== null));
    const loadStorage = (): Promise<Buffer> =>
      enc && key ? decryptFileToBuffer(storageFile, key, STORAGE_FILE) : readFile(storageFile);

    // 3. Restore into the scratch database.
    const url = this.config.get('BACKUP_VERIFY_DATABASE_URL', { infer: true });
    if (!url) {
      add('restore', false, 'set BACKUP_VERIFY_DATABASE_URL to a scratch database whose name contains "restore" or "verify"');
      return result(null, false);
    }
    const target = dbTarget(url);
    if (!SCRATCH_NAME.test(target.database)) {
      add('restore', false, `refused: "${target.database}" is not named as a scratch database (restore / verify)`);
      return result(null, false);
    }
    if (sameDatabase(target, dbTarget(this.config.get('DATABASE_URL', { infer: true })))) {
      add('restore', false, 'refused: BACKUP_VERIFY_DATABASE_URL is the live database');
      return result(null, false);
    }

    const started = Date.now();
    try {
      await this.empty(target);
    } catch (err) {
      // E.g. it does not exist yet: it is created once from the hosting panel.
      add('restore', false, `cannot use ${target.database} (create it first, from the hosting panel): ${firstLine(err)}`);
      return result(null, false);
    }
    let loaded = false;
    try {
      const dump = enc && key ? await createDecryptStream(dumpFile, key, DB_FILE) : createReadStream(dumpFile);
      await this.load(target, dump, root);
      loaded = true;
      add('restore', true, `${target.database} loaded in ${Math.round((Date.now() - started) / 1000)} s`);
      const conn = await mariadb.createConnection({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database,
      });
      try {
        await this.inspect(conn, manifest, loadStorage, add);
      } finally {
        await conn.end();
      }
    } catch (err) {
      // A failed load is the restore; a failure after it is the inspection.
      add(loaded ? 'inspect' : 'restore', false, firstLine(err));
    } finally {
      // --keep holds even on failure: that is when the copy is worth a look.
      if (!keep) {
        try {
          await this.empty(target);
        } catch (err) {
          // Reported with the other checks; the next run empties it first anyway.
          add('cleanup', false, `could not empty ${target.database}: ${firstLine(err)}`);
        }
      }
    }
    return result(target.database, keep);
  }

  /**
   * Empties the scratch database: drops every table and view in it. No
   * CREATE / DROP DATABASE, which hosting accounts usually may not run: the
   * database itself is created once from the hosting panel.
   */
  private async empty(target: DbTarget): Promise<void> {
    const conn = await mariadb.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.database,
    });
    try {
      const tables = (await conn.query(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
      )) as { name: string; type: string }[];
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of tables) {
        // Names come from information_schema of this database; quoted as identifiers.
        const name = t.name.replace(/`/g, '``');
        await conn.query(t.type === 'VIEW' ? `DROP VIEW IF EXISTS \`${name}\`` : `DROP TABLE IF EXISTS \`${name}\``);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
      await conn.end();
    }
  }

  /**
   * gunzip → the mysql client, into the scratch database. `dump` is the
   * plaintext-or-decrypting stream of the dump file. A decryption failure is
   * reported in preference to the client's EPIPE it causes.
   */
  private async load(target: DbTarget, dump: Readable, root: string): Promise<void> {
    const bin = this.config.get('MYSQL_PATH', { infer: true });
    // A scratch folder of this run: the credentials file lives only in it, and it goes when the load ends,
    // or when an interrupt arrives (the folder is removed whole, files only: nothing is emptied here).
    const scratch = await mkdtemp(path.join(root, VERIFY_SCRATCH_PREFIX));
    await chmod(scratch, PRIVATE_DIR);
    const unregister = onAbort(() => rm(scratch, { recursive: true, force: true }));
    try {
      await withOptionFile(
        target,
        async (options) => {
          const { done, stdin } = runTool(
            bin,
            [`--defaults-extra-file=${options}`, '--default-character-set=utf8mb4', target.database],
            { stdin: true },
          );
          const [client, feed] = await Promise.allSettled([done, pipeline(dump, createGunzip(), stdin!)]);
          if (feed.status === 'rejected' && (feed.reason as NodeJS.ErrnoException).code !== 'EPIPE') throw feed.reason;
          if (client.status === 'rejected') throw client.reason;
          if (feed.status === 'rejected') throw feed.reason;
        },
        scratch,
      );
    } finally {
      unregister();
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async inspect(
    conn: Connection,
    manifest: BackupManifest,
    loadStorage: () => Promise<Buffer>,
    add: (name: string, ok: boolean, detail: string) => void,
  ): Promise<void> {
    const count = async (sql: string): Promise<number> => Number(((await conn.query(sql)) as { n: bigint }[])[0].n);

    const migrations = (await conn.query(
      `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
    )) as { migration_name: string }[];
    const last = migrations.at(-1)?.migration_name ?? null;
    add(
      'migrations',
      migrations.length === manifest.migrations.count && last === manifest.migrations.last,
      `${migrations.length} applied, last ${last ?? 'none'} (backup had ${manifest.migrations.count}, ${manifest.migrations.last ?? 'none'})`,
    );

    // Every posted entry balances (the books of every tenant balance).
    const unbalanced = await count(`
      SELECT COUNT(*) AS n FROM (
        SELECT e.id FROM journal_entries e
        JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
        WHERE e.status = 'POSTED'
        GROUP BY e.tenant_id, e.id
        HAVING SUM(l.debit) <> SUM(l.credit)) x`);
    const posted = await count(`SELECT COUNT(*) AS n FROM journal_entries WHERE status = 'POSTED'`);
    add('journal', unbalanced === 0, unbalanced ? `${unbalanced} posted entries do not balance` : `${posted} posted entries, all balanced`);

    // stock_balances is a projection of stock_movements (§9.1): both ways.
    const moved = `SELECT tenant_id, warehouse_id, item_id, SUM(qty_in - qty_out) AS q
                   FROM stock_movements GROUP BY tenant_id, warehouse_id, item_id`;
    const mismatched = await count(`
      SELECT COUNT(*) AS n FROM (
        SELECT b.item_id FROM stock_balances b
        LEFT JOIN (${moved}) m ON m.tenant_id = b.tenant_id AND m.warehouse_id = b.warehouse_id AND m.item_id = b.item_id
        WHERE b.qty_on_hand <> COALESCE(m.q, 0)
        UNION ALL
        SELECT m.item_id FROM (${moved}) m
        LEFT JOIN stock_balances b ON b.tenant_id = m.tenant_id AND b.warehouse_id = m.warehouse_id AND b.item_id = m.item_id
        WHERE b.tenant_id IS NULL AND m.q <> 0) x`);
    add('stock', mismatched === 0, mismatched ? `${mismatched} stock balances differ from their movements` : 'balances equal the movements');

    // Every file the database points to is in the storage zip.
    const keys = new Set(Object.keys(unzipSync(await loadStorage())));
    const referenced = (await conn.query('SELECT storage_key FROM attachments')) as { storage_key: string }[];
    const missing = referenced.map((r) => r.storage_key).filter((k) => !keys.has(k));
    add(
      'storage',
      missing.length === 0,
      missing.length ? `${missing.length} files missing, e.g. ${missing.slice(0, 3).join(', ')}` : `${referenced.length} referenced, ${keys.size} in the zip`,
    );

    const [t, u, j, s] = await Promise.all(
      ['tenants', 'users', 'journal_entries', 'stock_movements'].map((table) => count(`SELECT COUNT(*) AS n FROM ${table}`)),
    );
    add('rows', true, `tenants ${t}, users ${u}, journal entries ${j}, stock movements ${s}`);
  }
}
