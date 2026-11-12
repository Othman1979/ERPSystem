import { z } from 'zod';
import { isSealingKey } from '../crypto/secret-box.js';
import { LOOPBACK_HOSTS } from '../net/loopback.js';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // JoFotara (docs/decisions/0005 §13): 32 random bytes, base64; seals the Secret-Key at rest.
  EINVOICE_ENC_KEY: z.string().optional(),
  // In-process outbox loop: 'on' for development only. Production sends by Cron
  // (job:einvoice-send every minute, ADR-009 §15): no daemon.
  EINVOICE_WORKER: z.enum(['on', 'off']).default('off'),
  EINVOICE_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
  // Past this the answer is UNKNOWN (never resent automatically).
  EINVOICE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
  // Extra hosts a SANDBOX URL may use besides this machine (comma-separated).
  EINVOICE_SANDBOX_HOSTS: z.string().optional(),
  // Report exports (Phase 8): most rows one PDF / XLSX export may have (REPORT_TOO_LARGE above).
  REPORT_PDF_MAX_ROWS: z.coerce.number().int().positive().default(1_000),
  REPORT_XLSX_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  // Subscriptions (Phase 9, ADR-009): trial length at registration, grace after
  // a paid period ends, data kept after cancellation (never deleted automatically).
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Uploaded files (company logo): a folder outside the web root (ADR-009 §7).
  STORAGE_DIR: z.string().min(1).default('storage'),
  // Reverse proxies in front of the API (the host's, nginx): how many, so req.ip
  // (rate limits, audit) is the client's address. 0 = clients connect directly.
  // More than the real count lets a client forge its address (ADR-010 §10.1).
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  // The built web app (apps/web/dist), served by the API on the same origin
  // (ADR-010 §2). Unset: API only.
  WEB_DIST_DIR: z.string().min(1).optional(),
  // OpenAPI pages at /api/docs. Unset: on, except in production (ADR-010 §5).
  API_DOCS: z.enum(['on', 'off']).optional(),
  // Daily backups (ADR-010 §10.2, docs/runbooks/backup-restore.md): the folder
  // (outside the web root, apart from STORAGE_DIR), how many days to keep, the
  // client tools (mysqldump / mariadb-dump, mysql / mariadb), and the scratch
  // database backup-verify restores into (its name must contain restore or verify).
  BACKUP_DIR: z.string().min(1).default('backups'),
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  MYSQLDUMP_PATH: z.string().min(1).default('mysqldump'),
  MYSQL_PATH: z.string().min(1).default('mysql'),
  BACKUP_VERIFY_DATABASE_URL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * What production must have on top of the schema (ADR-010 §10.1). Each
 * problem names its variable; the API refuses to start.
 */
export function productionProblems(env: Env): { path: string; message: string }[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: { path: string; message: string }[] = [];
  if (env.JWT_ACCESS_SECRET.length < 32) {
    problems.push({ path: 'JWT_ACCESS_SECRET', message: 'must be at least 32 characters in production' });
  }
  let origin: URL | null = null;
  try {
    origin = new URL(env.CORS_ORIGIN);
  } catch {
    // reported below
  }
  // Browsers compare the Origin header exactly, as they serialise it: scheme
  // and host in lowercase, no default port, no path or trailing slash.
  if (!origin || origin.protocol !== 'https:' || LOOPBACK_HOSTS.has(origin.hostname) || origin.origin !== env.CORS_ORIGIN) {
    const exact = origin?.protocol === 'https:' && !LOOPBACK_HOSTS.has(origin.hostname) ? ` (here: ${origin.origin})` : '';
    problems.push({
      path: 'CORS_ORIGIN',
      message: `must be exactly the site's https:// origin in production: lowercase, no path or trailing slash${exact}`,
    });
  }
  if (!isSealingKey(env.EINVOICE_ENC_KEY)) {
    problems.push({ path: 'EINVOICE_ENC_KEY', message: 'is required in production: 32 random bytes, base64' });
  }
  if (env.EINVOICE_WORKER === 'on') {
    problems.push({
      path: 'EINVOICE_WORKER',
      message: 'must be off in production: e-invoices are sent by Cron (ADR-009 §15)',
    });
  }
  return problems;
}

export function validateEnv(config: Record<string, unknown>): Env {
  // `NAME=` in a .env file means unset: its default applies, or "required".
  const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== ''));
  const result = envSchema.safeParse(given);
  const issues = result.success
    ? productionProblems(result.data).map((p) => `${p.path}: ${p.message}`)
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (!result.success || issues.length > 0) {
    throw new Error(`Invalid environment configuration: ${issues.join('; ')}`);
  }
  return result.data;
}

/** Whether /api/docs is served (ADR-010 §5). */
export function apiDocsEnabled(env: Pick<Env, 'API_DOCS' | 'NODE_ENV'>): boolean {
  return (env.API_DOCS ?? (env.NODE_ENV === 'production' ? 'off' : 'on')) === 'on';
}
