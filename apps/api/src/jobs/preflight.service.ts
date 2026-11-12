import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env, trustProxySetting } from '../common/config/env.validation.js';
import { overlaps } from '../common/fs/is-inside.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackupService } from './backup/backup.service.js';
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

/** The plan registration puts a new tenant on (prisma/seed.ts). */
const TRIAL_PLAN = 'TRIAL';

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

/**
 * Before and after a deployment (ADR-010 §10.1): is this server ready to
 * take traffic? Reads only; the storage and backup checks write and remove one file each.
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
    const add = (name: string, ok: boolean, detail: string, level: PreflightCheck['level'] = ok ? 'info' : 'error') =>
      checks.push({ name, ok, level, detail });
    const env = this.config.get('NODE_ENV', { infer: true });

    // A check that throws (no table yet, no folder) fails itself; the others still run.
    const attempt = async (name: string, check: () => Promise<void>) => {
      try {
        await check();
      } catch (err) {
        add(name, false, name === 'database' ? `cannot connect: ${firstLine(err)}` : firstLine(err));
      }
    };

    // Loading the module already validated the environment (production rules included).
    add('environment', true, env === 'production' ? 'production' : `${env} (not production)`, env === 'production' ? 'info' : 'warn');
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
      env === 'production' && none ? 'warn' : 'info',
    );

    const db = this.prisma.client;
    let dbUp = false;
    await attempt('database', async () => {
      const [v] = await db.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
      dbUp = true;
      add('database', true, `connected, ${v.version}`);
    });

    if (dbUp) {
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
      await attempt('timezone', async () => {
        const [tz] = await db.$queryRaw<{ g: string; s: string }[]>`SELECT @@global.time_zone AS g, @@session.time_zone AS s`;
        add(
          'timezone',
          true,
          `node ${Intl.DateTimeFormat().resolvedOptions().timeZone}, database ${tz.g}/${tz.s}; business dates use Asia/Amman`,
        );
      });
    }

    await attempt('storage', () => this.storage(add));
    await attempt('backup', () => this.backupReady(add, env === 'production'));
    return { ok: checks.every((c) => c.ok), checks };
  }

  private async migrations(add: (name: string, ok: boolean, detail: string) => void): Promise<void> {
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

  /** BACKUP_DIR writable and apart from the uploads and the web folder; the dump tool runs. */
  private async backupReady(
    add: (name: string, ok: boolean, detail: string, level?: PreflightCheck['level']) => void,
    production: boolean,
  ): Promise<void> {
    const root = this.backup.backupRoot();
    const probe = path.join(root, `.preflight-${randomUUID()}`);
    await mkdir(root, { recursive: true });
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

  private async storage(add: (name: string, ok: boolean, detail: string) => void): Promise<void> {
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
