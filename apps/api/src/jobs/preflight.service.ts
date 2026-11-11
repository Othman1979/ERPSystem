import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

/** Whether `child` is `parent` or inside it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Before and after a deployment (ADR-010 §10.1): is this server ready to
 * take traffic? Reads only; the storage check writes and removes one file.
 * systemPrisma: platform-wide checks, no tenant (allowed in `jobs`).
 */
@Injectable()
export class PreflightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async run(): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    const add = (name: string, ok: boolean, detail: string, level: PreflightCheck['level'] = ok ? 'info' : 'error') =>
      checks.push({ name, ok, level, detail });
    const env = this.config.get('NODE_ENV', { infer: true });

    // Loading the module already validated the environment (production rules included).
    add('environment', true, env === 'production' ? 'production' : `${env} (not production)`, env === 'production' ? 'info' : 'warn');

    const db = this.prisma.client;
    let dbUp = false;
    try {
      const [v] = await db.$queryRaw<{ version: string }[]>`SELECT VERSION() AS version`;
      dbUp = true;
      add('database', true, `connected, ${v.version}`);
    } catch (err) {
      add('database', false, `cannot connect: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }

    if (dbUp) {
      await this.migrations(add);
      const trial = await db.plan.findFirst({ where: { code: TRIAL_PLAN }, select: { id: true } });
      add('plans', !!trial, trial ? `${TRIAL_PLAN} plan present` : `no ${TRIAL_PLAN} plan: run prisma db seed`);
      const admins = await db.user.count({ where: { isPlatformAdmin: true, isActive: true } });
      add(
        'platform-admin',
        true,
        admins > 0 ? `${admins} active` : 'none: node dist/jobs/cli.js grant-platform-admin <email>',
        admins > 0 ? 'info' : 'warn',
      );
      const [tz] = await db.$queryRaw<{ g: string; s: string }[]>`SELECT @@global.time_zone AS g, @@session.time_zone AS s`;
      add(
        'timezone',
        true,
        `node ${Intl.DateTimeFormat().resolvedOptions().timeZone}, database ${tz.g}/${tz.s}; business dates use Asia/Amman`,
      );
    }

    await this.storage(add);
    return { ok: checks.every((c) => c.ok), checks };
  }

  private async migrations(add: (name: string, ok: boolean, detail: string) => void): Promise<void> {
    // dist/jobs → apps/api/prisma/migrations (src/jobs in tests: the same depth).
    const dir = path.resolve(import.meta.dirname, '..', '..', 'prisma', 'migrations');
    const folders = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
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
    if (web && (isInside(root, web) || isInside(web, root))) {
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
