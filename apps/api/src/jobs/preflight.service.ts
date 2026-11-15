import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env, trustProxySetting } from '../common/config/env.validation.js';
import { LOOPBACK_HOSTS } from '../common/net/loopback.js';
import { overlaps } from '../common/fs/is-inside.js';
import { probeDatabase } from '../health/db-probe.js';
import { DEFAULT_POOL_LIMITS, JOB_POOL_SIZE, PrismaService } from '../prisma/prisma.service.js';
import { SCHEMA_STAMP_FILE, schemaHash } from '../prisma/schema-stamp.js';
import { BackupService, PRIVATE_DIR } from './backup/backup.service.js';
import { backupTime } from './backup/manifest.js';
import { firstLine, toolVersion } from './backup/mysql-tools.js';

export interface PreflightCheck {
  name: string;
  /** false fails the command (exit 1); a warning never does. */
  ok: boolean;
  level: 'error' | 'warn' | 'info';
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

type Add = (name: string, ok: boolean, detail: string, level?: PreflightCheck['level']) => void;

/** The plan registration puts a new tenant on (prisma/seed.ts). */
const TRIAL_PLAN = 'TRIAL';
const GIB = 1024 ** 3;
/** Below these free bytes a disk is an error, then a warning. */
const DISK_ERROR_BYTES = 1 * GIB;
const DISK_WARN_BYTES = 5 * GIB;
/** The daily backup runs every 24 h: an older newest backup means one was missed. */
const BACKUP_STALE_HOURS = 26;
const HOUR_MS = 60 * 60 * 1000;
/** The write probe waits this long before the check fails. */
const DB_WRITE_TIMEOUT_MS = 5000;
/** Supported MariaDB (ADR-019): the LTS range CI tests, as major * 1000 + minor. */
const MARIADB_OLDEST = 10_011;
const MARIADB_NEWEST_TESTED = 11_008;
/** Cron commands that can overlap (each with its own pool of JOB_POOL_SIZE; DB-07, deploy.md). */
const OVERLAPPING_CRON_JOBS = 3;

type Level = PreflightCheck['level'];
/** A check that only matters on a real server: an error in production, a warning elsewhere. */
const serverLevel = (production: boolean): Level => (production ? 'error' : 'warn');

/** The connection and database character set every table expects (migration 20261113164500, prisma.service.ts). */
export const EXPECTED_CHARSETS: Record<string, string> = {
  character_set_database: 'utf8mb4',
  collation_database: 'utf8mb4_unicode_ci',
  character_set_client: 'utf8mb4',
  character_set_connection: 'utf8mb4',
  character_set_results: 'utf8mb4',
  collation_connection: 'utf8mb4_unicode_ci',
};

/**
 * MariaDB from 10.11 to 11.8 (ADR-019). Not MariaDB, or older than 10.11, is
 * an error in production and a warning elsewhere (development runs XAMPP's
 * 10.4); newer than 11.8 is untested, a warning.
 */
export function databaseVersionLevel(version: string, production: boolean): { level: Level; detail: string } {
  // Old clients see a "5.5.5-" prefix on MariaDB's version.
  const v = version.replace(/^5\.5\.5-/, '');
  const m = /^(\d+)\.(\d+)\./.exec(v);
  if (!m || !/mariadb/i.test(v)) {
    return { level: serverLevel(production), detail: `${version} is not MariaDB: supported is MariaDB 10.11 to 11.8 (ADR-019)` };
  }
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  const at = major * 1000 + minor;
  if (at < MARIADB_OLDEST) {
    return { level: serverLevel(production), detail: `MariaDB ${major}.${minor} is older than 10.11, the oldest supported LTS (ADR-019)` };
  }
  if (at > MARIADB_NEWEST_TESTED) {
    return { level: 'warn', detail: `MariaDB ${major}.${minor} is newer than 11.8, the newest tested: add it to the test matrix (ADR-019)` };
  }
  return { level: 'info', detail: `MariaDB ${major}.${minor}, within 10.11 to 11.8 (ADR-019)` };
}

/** Each server variable that is not the expected utf8mb4 / utf8mb4_unicode_ci, as "name=value (expected x)". */
export function charsetProblems(row: Record<string, string | null | undefined>): string[] {
  return Object.entries(EXPECTED_CHARSETS)
    .filter(([name, expected]) => (row[name] ?? '').toLowerCase() !== expected)
    .map(([name, expected]) => `${name}=${row[name] ?? 'unknown'} (expected ${expected})`);
}

/**
 * Node and the database session in different UTC offsets: CURRENT_TIMESTAMP
 * defaults and NOW() in SQL then disagree with the times the application
 * writes. A warning: business dates use Asia/Amman either way.
 */
export function timezoneLevel(nodeOffsetMinutes: number, dbOffsetMinutes: number): Level {
  return nodeOffsetMinutes === dbOffsetMinutes ? 'info' : 'warn';
}

function utcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * NODE_ENV against where the site lives: a public CORS_ORIGIN (the site's
 * address) with NODE_ENV not production means a server running with
 * development rules (no production checks, insecure cookies, API docs on).
 */
export function environmentLevel(nodeEnv: string, corsOrigin: string): { level: Level; detail: string } {
  if (nodeEnv === 'production') return { level: 'info', detail: 'production' };
  let host = '';
  try {
    host = new URL(corsOrigin).hostname;
  } catch {
    // not a URL: treated as local
  }
  if (host === '' || LOOPBACK_HOSTS.has(host)) return { level: 'warn', detail: `${nodeEnv} (not production)` };
  return { level: 'error', detail: `NODE_ENV=${nodeEnv} on a public site (CORS_ORIGIN ${host}): set NODE_ENV=production` };
}

/** The settings among these that are relative paths (resolved against the working folder, which a Cron line may change). */
export function relativePaths(dirs: Record<string, string>): string[] {
  return Object.entries(dirs)
    .filter(([, dir]) => !path.isAbsolute(dir))
    .map(([name, dir]) => `${name}=${dir}`);
}

/** The API's DB_POOL_SIZE from its .env text (a Cron command's own pool is smaller, jobs/job-env.ts). */
export function apiPoolSize(envFile: string | null): number {
  const value = envFile === null ? undefined : parseEnv(envFile).DB_POOL_SIZE;
  const size = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(size) && size > 0 ? size : DEFAULT_POOL_LIMITS.size;
}

/**
 * The account's connection limit against what can be open at once: the API's
 * pool plus OVERLAPPING_CRON_JOBS Cron pools (DB-07). max_user_connections 0
 * means no per-account limit, then max_connections applies.
 */
export function connectionsLevel(
  maxUserConnections: number,
  maxConnections: number,
  apiPool: number,
): { level: Level; detail: string } {
  const need = apiPool + OVERLAPPING_CRON_JOBS * JOB_POOL_SIZE;
  const [limit, name] = maxUserConnections > 0 ? [maxUserConnections, 'max_user_connections'] : [maxConnections, 'max_connections'];
  const sum = `API pool ${apiPool} + ${OVERLAPPING_CRON_JOBS} Cron x ${JOB_POOL_SIZE} = ${need}`;
  if (limit < need) {
    return { level: 'warn', detail: `${name}=${limit} is below ${sum}: lower DB_POOL_SIZE, or requests fail waiting for a connection` };
  }
  return { level: 'info', detail: `${name}=${limit}, ${sum}` };
}

/**
 * The generated Prisma client against the schema on disk (prisma/schema-stamp.ts).
 * No stamp, or one from another schema, is an error in production and a warning elsewhere.
 */
export function prismaClientLevel(stamp: string | null, schema: string, production: boolean): { level: Level; detail: string } {
  const fix = 'run pnpm --filter api prisma:generate, then pnpm build';
  if (stamp === null) return { level: serverLevel(production), detail: `no ${SCHEMA_STAMP_FILE} with the built client: ${fix}` };
  const current = schemaHash(schema);
  if (stamp.trim() !== current) {
    return { level: serverLevel(production), detail: `the built client was generated from another prisma/schema.prisma: ${fix}` };
  }
  return { level: 'info', detail: `generated from the current schema (${current.slice(0, 12)})` };
}

/** Creates the folder if needed and writes and removes one probe file in it. */
export async function probeFolder(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const probe = path.join(dir, `.preflight-${randomUUID()}`);
  await writeFile(probe, 'ok');
  await rm(probe);
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

/** Migration folders against `_prisma_migrations` rows: what is missing or broken. */
export function compareMigrations(
  folders: string[],
  rows: { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[],
): { pending: string[]; failed: string[] } {
  const applied = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  return {
    pending: folders.filter((f) => !applied.has(f)).sort(),
    failed: rows
      .filter((r) => !r.finished_at && !r.rolled_back_at)
      .map((r) => r.migration_name)
      .sort(),
  };
}

/** Free space on a filesystem: an error below 1 GiB, a warning below 5 GiB. */
export function diskLevel(freeBytes: number): 'error' | 'warn' | 'info' {
  if (freeBytes < DISK_ERROR_BYTES) return 'error';
  if (freeBytes < DISK_WARN_BYTES) return 'warn';
  return 'info';
}

/**
 * The newest backup's age (ADR-010 §10.2). No backup at all is a warning;
 * a backup older than BACKUP_STALE_HOURS is an error in production (the
 * daily Cron is failing), a warning elsewhere.
 */
export function backupAgeLevel(
  newest: Date | null,
  now: Date,
  production: boolean,
): { level: 'error' | 'warn' | 'info'; detail: string } {
  if (newest === null) return { level: 'warn', detail: 'no backup yet: run job:backup' };
  const hours = (now.getTime() - newest.getTime()) / HOUR_MS;
  if (hours > BACKUP_STALE_HOURS) {
    return {
      level: production ? 'error' : 'warn',
      detail: `newest backup is ${hours.toFixed(1)} h old (the daily backup should be under ${BACKUP_STALE_HOURS} h)`,
    };
  }
  return { level: 'info', detail: `newest backup ${hours.toFixed(1)} h old` };
}

/** The nearest folder that exists: where the free space of a folder not yet created is read. */
function nearestExisting(folder: string): string {
  let current = path.resolve(folder);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function gigabytes(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/**
 * Before and after a deployment (ADR-010 §10.1): is this server ready to
 * take traffic? It writes only where it must prove a write works: the
 * storage and backup checks write and remove one probe file each, and the
 * database check writes one row inside a transaction it rolls back. Nothing
 * is kept.
 * systemPrisma: platform-wide checks, no tenant (allowed in `jobs`).
 */
@Injectable()
export class PreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly backup: BackupService,
  ) {}

  async run(): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    const add: Add = (name, ok, detail, level = ok ? 'info' : 'error') => checks.push({ name, ok, level, detail });
    const env = this.config.get('NODE_ENV', { infer: true });
    const production = env === 'production';

    // A check that throws (no table yet, no folder) fails itself; the others still run.
    const attempt = async (name: string, check: () => Promise<void>) => {
      try {
        await check();
      } catch (err) {
        add(name, false, name === 'database' ? `cannot connect: ${firstLine(err)}` : firstLine(err));
      }
    };

    // Loading the module already validated the environment (production rules included).
    const environment = environmentLevel(env, this.config.get('CORS_ORIGIN', { infer: true }));
    add('environment', environment.level !== 'error', environment.detail, environment.level);
    // ADR-011: which proxies may name the client; none trusted behind a proxy
    // means every client shares one rate limit (the API also logs it then).
    const proxies = this.config.get('TRUST_PROXY', { infer: true });
    const none = trustProxySetting(proxies) === false;
    add(
      'proxy',
      true,
      none
        ? `TRUST_PROXY=${proxies}: no proxy trusted; behind the host proxy every client shares one rate limit`
        : `TRUST_PROXY=${proxies}`,
      production && none ? 'warn' : 'info',
    );

    const db = this.prisma.client;
    let dbUp = false;
    await attempt('database', async () => {
      const [v] = await db.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
      dbUp = true;
      add('database', true, `connected, ${v.version}`);
      const supported = databaseVersionLevel(v.version, production);
      add('database-version', supported.level !== 'error', supported.detail, supported.level);
    });

    if (dbUp) {
      await attempt('charset', async () => {
        const [row] = await db.$queryRaw<Record<string, string | null>[]>`
          SELECT @@character_set_database AS character_set_database, @@collation_database AS collation_database,
                 @@character_set_client AS character_set_client, @@character_set_connection AS character_set_connection,
                 @@character_set_results AS character_set_results, @@collation_connection AS collation_connection`;
        const problems = charsetProblems(row);
        if (problems.length === 0) add('charset', true, 'database and connection utf8mb4 / utf8mb4_unicode_ci');
        else {
          const level = serverLevel(production);
          add('charset', level !== 'error', `${problems.join(', ')}: create the database as utf8mb4 / utf8mb4_unicode_ci (deploy.md)`, level);
        }
      });
      await attempt('connections', async () => {
        const [row] = await db.$queryRaw<{ u: bigint | number; m: bigint | number }[]>`
          SELECT @@max_user_connections AS u, @@max_connections AS m`;
        // A Cron command (this one too) runs with its own small pool: the API's is in .env.
        const pool = apiPoolSize(await readIfExists(path.resolve('.env')));
        const { level, detail } = connectionsLevel(Number(row.u), Number(row.m), pool);
        add('connections', true, detail, level);
      });
      await attempt('database-write', async () => {
        // PLAT-31: a database that answers SELECT but cannot write or use its temp directory.
        const probe = await probeDatabase(db, DB_WRITE_TIMEOUT_MS);
        if (probe.ok) {
          add(
            'database-write',
            true,
            `writes and temp tables ${probe.tmpdir === 'ok' ? 'ok' : 'not measured (no sequence table)'}, ${probe.ms} ms`,
          );
        } else {
          add('database-write', false, probe.reason);
        }
      });
      await attempt('migrations', () => this.migrations(add));
      await attempt('plans', async () => {
        const trial = await db.plan.findFirst({ where: { code: TRIAL_PLAN }, select: { id: true } });
        add('plans', !!trial, trial ? `${TRIAL_PLAN} plan present` : `no ${TRIAL_PLAN} plan: run prisma db seed`);
      });
      await attempt('platform-admin', async () => {
        const admins = await db.user.count({ where: { isPlatformAdmin: true, isActive: true } });
        add(
          'platform-admin',
          true,
          admins > 0 ? `${admins} active` : 'none: node dist/jobs/cli.js grant-platform-admin <email>',
          admins > 0 ? 'info' : 'warn',
        );
      });
      await attempt('isolation', async () => {
        // MariaDB 11.6.2+ defaults innodb_snapshot_isolation ON; the pool turns it
        // off per session (SESSION_INIT_SQL). Still ON here means a server where
        // that statement does not apply and someone set it ON: concurrent
        // postings would fail with 1020 instead of waiting.
        const rows = await db.$queryRaw<{ Value: string }[]>`SHOW SESSION VARIABLES LIKE 'innodb_snapshot_isolation'`;
        const value = rows[0]?.Value;
        if (value === undefined) add('isolation', true, 'innodb_snapshot_isolation not present (MariaDB before 10.6.18, or MySQL)');
        else if (value.toUpperCase() === 'OFF') add('isolation', true, 'innodb_snapshot_isolation OFF for the application connections');
        else add('isolation', false, 'innodb_snapshot_isolation is ON: set it OFF globally, or concurrent postings fail with 1020');
      });
      await attempt('timezone', async () => {
        const [tz] = await db.$queryRaw<{ g: string; s: string; off: bigint | number }[]>`
          SELECT @@global.time_zone AS g, @@session.time_zone AS s, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS off`;
        const nodeOffset = -new Date().getTimezoneOffset();
        const dbOffset = Number(tz.off);
        const level = timezoneLevel(nodeOffset, dbOffset);
        add(
          'timezone',
          true,
          `node ${Intl.DateTimeFormat().resolvedOptions().timeZone} (${utcOffset(nodeOffset)}), database ${tz.g}/${tz.s} (${utcOffset(dbOffset)})` +
            `${level === 'warn' ? ': the offsets differ, so SQL NOW() and the times Node writes disagree' : ''}; business dates use Asia/Amman`,
          level,
        );
      });
    }

    await attempt('prisma-client', () => this.prismaClient(add, production));
    await attempt('error-log', async () => {
      const dir = path.dirname(path.resolve(this.config.get('ERROR_LOG_FILE', { infer: true })));
      await probeFolder(dir);
      add('error-log', true, `writable: ${dir}`);
    });
    await attempt('paths', async () => {
      const relative = relativePaths({
        STORAGE_DIR: this.config.get('STORAGE_DIR', { infer: true }),
        BACKUP_DIR: this.config.get('BACKUP_DIR', { infer: true }),
      });
      add(
        'paths',
        true,
        relative.length ? `${relative.join(', ')} relative to ${process.cwd()}: use absolute paths on a server` : 'STORAGE_DIR and BACKUP_DIR absolute',
        relative.length ? 'warn' : 'info',
      );
    });
    await attempt('storage', () => this.storage(add));
    await attempt('backup', () => this.backupReady(add, production));
    await attempt('disk', () => this.disks(add, dbUp));
    await attempt('backup-age', () => this.backupAge(add, production));
    await attempt('restore-tool', () => this.restoreTool(add, production));
    await attempt('backup-key', async () => this.backupKey(add));
    return { ok: checks.every((c) => c.ok), checks };
  }

  private async migrations(add: Add): Promise<void> {
    // dist/jobs → apps/api/prisma/migrations (src/jobs in tests: the same depth).
    const dir = path.resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
    if (!existsSync(dir)) {
      add('migrations', false, `no migrations folder at ${dir}: deploy apps/api/prisma with the build`);
      return;
    }
    const folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    const [table] = await this.prisma.client.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = '_prisma_migrations'`;
    if (Number(table.n) === 0) {
      add('migrations', false, `none applied of ${folders.length}: run prisma migrate deploy`);
      return;
    }
    const rows = await this.prisma.client.$queryRaw<
      { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
    >`SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`;
    const { pending, failed } = compareMigrations(folders, rows);
    const problems = [
      ...(pending.length ? [`pending: ${pending.join(', ')} (run prisma migrate deploy)`] : []),
      ...(failed.length ? [`failed: ${failed.join(', ')}`] : []),
    ];
    add('migrations', problems.length === 0, problems.length ? problems.join('; ') : `${folders.length} applied`);
  }

  /**
   * The client this build runs (dist/generated/prisma; src/generated/prisma in
   * tests: the same depth) against prisma/schema.prisma. The stamp reaches dist
   * through nest-cli.json assets.
   */
  private async prismaClient(add: Add, production: boolean): Promise<void> {
    const generated = path.resolve(import.meta.dirname, '..', 'generated', 'prisma');
    const schema = await readFile(path.resolve(import.meta.dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const { level, detail } = prismaClientLevel(await readIfExists(path.join(generated, SCHEMA_STAMP_FILE)), schema, production);
    add('prisma-client', level !== 'error', detail, level);
  }

  /** BACKUP_DIR writable and apart from the uploads and the web folder; the dump tool runs. */
  private async backupReady(add: Add, production: boolean): Promise<void> {
    const root = this.backup.backupRoot();
    const probe = path.join(root, `.preflight-${randomUUID()}`);
    // Created private, as the backup itself would (it holds every tenant's data).
    await mkdir(root, { recursive: true, mode: PRIVATE_DIR });
    await writeFile(probe, 'ok');
    await rm(probe);
    const bin = this.config.get('MYSQLDUMP_PATH', { infer: true });
    const version = await toolVersion(bin);
    const keep = this.config.get('BACKUP_KEEP_DAYS', { infer: true });
    if (version) {
      add('backup', true, `writable: ${root}, kept ${keep} days; ${version}`);
    } else {
      // Without the tool the daily backup fails: an error where it matters.
      add('backup', !production, `${bin} cannot run: set MYSQLDUMP_PATH (backups in ${root})`, production ? 'error' : 'warn');
    }
  }

  /**
   * Free space where this server writes: the backup, storage and error-log
   * folders, and (only for a database on this machine) its temp and data
   * folders. One check per distinct filesystem path, named by that path.
   */
  private async disks(add: Add, dbUp: boolean): Promise<void> {
    const folders = new Set<string>();
    const attemptFolder = (fn: () => string) => {
      try {
        folders.add(nearestExisting(fn()));
      } catch (err) {
        add('disk', false, `cannot read a folder: ${firstLine(err)}`);
      }
    };
    attemptFolder(() => this.backup.backupRoot());
    attemptFolder(() => this.config.get('STORAGE_DIR', { infer: true }));
    attemptFolder(() => path.dirname(path.resolve(this.config.get('ERROR_LOG_FILE', { infer: true }))));

    if (dbUp && this.databaseIsLocal()) {
      try {
        const [row] = await this.prisma.client.$queryRaw<{ t: string; d: string }[]>`SELECT @@tmpdir AS t, @@datadir AS d`;
        const local = [...row.t.split(path.delimiter), row.d].map((p) => p.trim()).filter((p) => p !== '' && existsSync(p));
        for (const p of local) folders.add(nearestExisting(p));
      } catch {
        // The database check reports a database that does not answer.
      }
    }

    for (const folder of folders) {
      try {
        const fs = await statfs(folder);
        const free = Number(fs.bavail) * Number(fs.bsize);
        const level = diskLevel(free);
        add('disk', level !== 'error', `${folder} ${gigabytes(free)} free`, level);
      } catch (err) {
        add('disk', false, `${folder}: ${firstLine(err)}`);
      }
    }
  }

  /** The database host is this machine (the temp and data folders are then local). */
  private databaseIsLocal(): boolean {
    try {
      return LOOPBACK_HOSTS.has(new URL(this.config.get('DATABASE_URL', { infer: true })).hostname);
    } catch {
      return false;
    }
  }

  /** The newest complete backup (a folder named by its time, not a partial one) and how old it is. */
  private async backupAge(add: Add, production: boolean): Promise<void> {
    const root = this.backup.backupRoot();
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
      entries = [];
    }
    let newest: Date | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const at = backupTime(entry.name);
      if (at !== null && (newest === null || at > newest)) newest = at;
    }
    const { level, detail } = backupAgeLevel(newest, new Date(), production);
    add('backup-age', level !== 'error', detail, level);
  }

  /** The MySQL client that backup-verify restores with. */
  private async restoreTool(add: Add, production: boolean): Promise<void> {
    const bin = this.config.get('MYSQL_PATH', { infer: true });
    const version = await toolVersion(bin);
    if (version) {
      add('restore-tool', true, `${version} (backup-verify)`);
    } else {
      add('restore-tool', !production, `${bin} cannot run: set MYSQL_PATH (backup-verify needs it)`, production ? 'error' : 'warn');
    }
  }

  /** Backups are written unencrypted without a key (production refuses to start without one). */
  private backupKey(add: Add): void {
    const key = this.config.get('BACKUP_ENCRYPTION_KEY', { infer: true });
    if (key) add('backup-key', true, 'BACKUP_ENCRYPTION_KEY set');
    else add('backup-key', true, 'BACKUP_ENCRYPTION_KEY unset: backups are written unencrypted', 'warn');
  }

  private async storage(add: Add): Promise<void> {
    const root = path.resolve(this.config.get('STORAGE_DIR', { infer: true }));
    const webDir = this.config.get('WEB_DIST_DIR', { infer: true });
    const web = webDir ? path.resolve(webDir) : null;

    if (web) {
      const index = existsSync(path.join(web, 'index.html'));
      add('web', index, index ? `serving ${web}` : `no index.html in ${web} (build apps/web)`);
    } else {
      add('web', true, 'WEB_DIST_DIR unset: API only, the web app is served elsewhere');
    }

    // Uploaded files must never be reachable as web pages.
    if (web && overlaps(root, web)) {
      add('storage', false, `STORAGE_DIR ${root} overlaps WEB_DIST_DIR ${web}`);
      return;
    }
    const probe = path.join(root, `.preflight-${randomUUID()}`);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(probe, 'ok');
      await rm(probe);
      add('storage', true, `writable: ${root} (keep it in the daily backup)`);
    } catch (err) {
      add('storage', false, `not writable: ${root}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
