import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unzipSync } from 'fflate';
import mariadb, { type Connection } from 'mariadb';
import type { Env } from '../../common/config/env.validation.js';
import { type BackupManifest, backupTime, DB_FILE, MANIFEST_FILE, sha256File, STORAGE_FILE } from './manifest.js';
import { allOrFirstError, dbTarget, type DbTarget, firstLine, runTool, sameDatabase, withOptionFile } from './mysql-tools.js';

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
}

/** A scratch database: its name says so, so a typo cannot point this at real data. */
const SCRATCH_NAME = /restore|verify/i;

/**
 * Proves a backup can be restored (ADR-010 §10.2, acceptance "a restore in a
 * test environment succeeds and is documented"):
 *  1. every file matches its manifest checksum;
 *  2. the dump is loaded into BACKUP_VERIFY_DATABASE_URL, a scratch database
 *     (dropped and recreated; never the live one);
 *  3. the restored data is checked: same migrations, every posted journal
 *     entry balanced, stock balances equal to the movements, every uploaded
 *     file referenced by the database present in the storage zip.
 * The scratch database is dropped afterwards unless `keep`.
 * Cross-tenant SQL on purpose: the whole restored copy is checked, through
 * the driver, outside the application (allowed in `jobs`).
 */
@Injectable()
export class BackupVerifyService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async run(which: string, keep = false): Promise<VerifyResult> {
    const folder = await this.resolveFolder(which);
    const checks: VerifyCheck[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const result = (restoredInto: string | null, kept: boolean): VerifyResult => ({
      ok: checks.every((c) => c.ok),
      folder,
      restoredInto,
      kept,
      checks,
    });

    const manifest = JSON.parse(await readFile(path.join(folder, MANIFEST_FILE), 'utf8')) as BackupManifest;
    if (manifest.format !== 1) throw new Error(`Unknown manifest format ${String(manifest.format)}`);

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

    // 2. Restore into the scratch database.
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
      await this.recreate(target);
    } catch (err) {
      // E.g. the database user may not create databases: say so as a check.
      add('restore', false, `cannot create ${target.database}: ${firstLine(err)}`);
      return result(null, false);
    }
    let loaded = false;
    try {
      await this.load(target, path.join(folder, DB_FILE));
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
        await this.inspect(conn, manifest, path.join(folder, STORAGE_FILE), add);
      } finally {
        await conn.end();
      }
    } catch (err) {
      // A failed load is the restore; a failure after it is the inspection.
      add(loaded ? 'inspect' : 'restore', false, firstLine(err));
    } finally {
      // --keep holds even on failure: that is when the copy is worth a look.
      if (!keep) await this.drop(target);
    }
    return result(target.database, keep);
  }

  /** `latest`, a path, or a folder name under BACKUP_DIR. */
  private async resolveFolder(which: string): Promise<string> {
    const root = path.resolve(this.config.get('BACKUP_DIR', { infer: true }));
    if (which === 'latest') {
      const names = existsSync(root)
        ? (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && backupTime(d.name)).map((d) => d.name)
        : [];
      const newest = names.sort().at(-1);
      if (!newest) throw new Error(`No backup in ${root}`);
      return path.join(root, newest);
    }
    const folder = existsSync(which) ? path.resolve(which) : path.join(root, which);
    if (!existsSync(path.join(folder, MANIFEST_FILE))) throw new Error(`No backup at ${folder} (no ${MANIFEST_FILE})`);
    return folder;
  }

  private async server(target: DbTarget): Promise<Connection> {
    return mariadb.createConnection({ host: target.host, port: target.port, user: target.user, password: target.password });
  }

  private async recreate(target: DbTarget): Promise<void> {
    const conn = await this.server(target);
    try {
      // The name was checked against [A-Za-z0-9_]+ (dbTarget) and the scratch pattern.
      await conn.query(`DROP DATABASE IF EXISTS \`${target.database}\``);
      await conn.query(`CREATE DATABASE \`${target.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    } finally {
      await conn.end();
    }
  }

  private async drop(target: DbTarget): Promise<void> {
    const conn = await this.server(target);
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${target.database}\``);
    } finally {
      await conn.end();
    }
  }

  /** gunzip → the mysql client, into the scratch database. */
  private async load(target: DbTarget, dump: string): Promise<void> {
    const bin = this.config.get('MYSQL_PATH', { infer: true });
    await withOptionFile(target, async (options) => {
      const { done, stdin } = runTool(
        bin,
        [`--defaults-extra-file=${options}`, '--default-character-set=utf8mb4', target.database],
        { stdin: true },
      );
      await allOrFirstError([done, pipeline(createReadStream(dump), createGunzip(), stdin!)]);
    });
  }

  private async inspect(
    conn: Connection,
    manifest: BackupManifest,
    storageZip: string,
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
    const keys = new Set(Object.keys(unzipSync(await readFile(storageZip))));
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
