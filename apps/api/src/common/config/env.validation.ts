import { z } from 'zod';
import { isSealingKey } from '../crypto/secret-box.js';
import { LOOPBACK_HOSTS } from '../net/loopback.js';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Database connections per process (DB-07): the API and each Cron command
  // open their own pool. Keep the API's pool plus the Cron pools that can run
  // at once under the host's max_user_connections. This is the API's; a Cron
  // command uses 2 unless its own line passes DB_POOL_SIZE (jobs/job-env.ts).
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  // How long a query waits for a free connection before it fails.
  DB_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  TENANCY_MODE: z.enum(['shared', 'isolated']).default('shared'),
  TENANT_DB_POOL_SIZE: z.coerce.number().int().min(1).max(20).default(3),
  TENANT_DB_IDLE_MS: z.coerce.number().int().positive().default(600_000),
  TENANT_DB_MAX_POOLS: z.coerce.number().int().min(1).max(500).default(50),
  TENANT_DB_STATE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  TENANT_DB_SECRET_KEY: z.string().optional(),
  TENANT_DB_PASSWORD: z.preprocess((value) => value === '' ? undefined : value, z.string().optional()),
  DB_PROVISIONER: z.preprocess((value) => value === '' ? undefined : value, z.enum(['create', 'pool']).optional()),
  TENANT_DB_ADMIN_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  TENANT_DB_HOST: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  TENANT_DB_NAME_PREFIX: z.string().regex(/^[a-z0-9_]{1,52}$/).default('erp_t_'),
  TENANT_DB_USER_HOST: z.string().min(1).default('%'),
  TENANT_DB_POOL_LOW_WATER: z.coerce.number().int().min(0).default(5),
  TENANT_DB_POOL_TARGET: z.coerce.number().int().positive().default(3),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(16),
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
  // PRODUCTION e-invoicing (real JoFotara) outside NODE_ENV=production only when
  // explicitly 'true' (decisions.md TRADE-24). Any value but true/false is refused.
  EINVOICE_ALLOW_PRODUCTION: z.enum(['true', 'false']).default('false'),
  // Report exports (Phase 8): most rows one PDF / XLSX export may have (REPORT_TOO_LARGE above).
  REPORT_PDF_MAX_ROWS: z.coerce.number().int().positive().default(1_000),
  REPORT_XLSX_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
  // Proxies whose X-Forwarded-For gives the client address for request limits (ADR-011):
  // false, a hop count, or addresses/subnets such as "loopback, 10.0.0.0/8". Never "true" on a public server.
  TRUST_PROXY: z.string().default('loopback'),
  // Subscriptions (Phase 9, ADR-009): trial length at registration, grace after
  // a paid period ends, data kept after cancellation (never deleted automatically).
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
  RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // Uploaded files (company logo): a folder outside the web root (ADR-009 §7).
  STORAGE_DIR: z.string().min(1).default('storage'),
  // The built web app (apps/web/dist), served by the API on the same origin
  // (ADR-010 §2). Unset: API only.
  WEB_DIST_DIR: z.string().min(1).optional(),
  // OpenAPI pages at /api/docs. Unset: on, except in production (ADR-010 §5).
  API_DOCS: z.enum(['on', 'off']).optional(),
  // Tests only (PLAT-15): every 2xx answer that does not match its OpenAPI
  // response schema is appended to this file. Ignored in production.
  OPENAPI_RESPONSE_AUDIT: z.string().min(1).optional(),
  // Daily backups (ADR-010 §10.2, docs/runbooks/backup-restore.md): the folder
  // (outside the web root, apart from STORAGE_DIR), how many days to keep, the
  // client tools (mysqldump / mariadb-dump, mysql / mariadb), and the scratch
  // database backup-verify restores into (its name must contain restore or verify).
  BACKUP_DIR: z.string().min(1).default('backups'),
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  MYSQLDUMP_PATH: z.string().min(1).default('mysqldump'),
  MYSQL_PATH: z.string().min(1).default('mysql'),
  BACKUP_VERIFY_DATABASE_URL: z.string().min(1).optional(),
  // Error alerts (ADR-010 §10.3): the hourly error-digest command posts new
  // errors here as JSON { text, content } (Slack, Discord, Mattermost, a
  // Telegram sendMessage URL with chat_id). A secret: never logged. Unset: no alerts.
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  // Backup encryption (ADR-010 §10.2): 32 random bytes, base64. Every backup file is
  // AES-256-GCM encrypted with it; backup-verify needs the same key. Required in production.
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
  // Where the error monitor appends errors it could not write to the database (ADR-010 §10.3);
  // error-digest alerts them. Outside the web root.
  ERROR_LOG_FILE: z.string().min(1).default('logs/errors-fallback.log'),
  // NODE_ENV=test mounts test-only routes (TestSupportModule). Outside a Jest run
  // (JEST_WORKER_ID) it is refused unless this is 'true': a server copied with
  // NODE_ENV=test must not start with those routes open.
  ALLOW_TEST_ENV: z.enum(['true', 'false']).default('false'),
}).superRefine((env, ctx) => {
  if (env.TENANCY_MODE === 'isolated' && !isSealingKey(env.TENANT_DB_SECRET_KEY)) {
    ctx.addIssue({
      code: 'custom',
      path: ['TENANT_DB_SECRET_KEY'],
      message: 'is required in isolated mode: 32 random bytes, base64',
    });
  }
  if (env.TENANCY_MODE === 'isolated' && !env.DB_PROVISIONER) {
    ctx.addIssue({
      code: 'custom',
      path: ['DB_PROVISIONER'],
      message: 'is required in isolated mode',
    });
  }
  if (env.DB_PROVISIONER === 'create' && !env.TENANT_DB_ADMIN_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['TENANT_DB_ADMIN_URL'],
      message: 'is required when DB_PROVISIONER=create',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

/** Words of the placeholder secrets in the .env.example files and the runbooks: never a real secret. */
const PLACEHOLDER_WORDS = ['change-me', 'dev-only', 'example'];

/** The secrets production requires; none may be a copied placeholder. */
const PRODUCTION_SECRETS = ['JWT_ACCESS_SECRET', 'EINVOICE_ENC_KEY', 'BACKUP_ENCRYPTION_KEY'] as const;

function placeholderWord(value: string | undefined): string | undefined {
  const lower = value?.toLowerCase() ?? '';
  return PLACEHOLDER_WORDS.find((word) => lower.includes(word));
}

/** Where productionProblems runs: a Jest run may point production mode at the local test database. */
export interface ProductionContext {
  underTest?: boolean;
}

/**
 * What production must have on top of the schema (ADR-010 §10.1). Each
 * problem names its variable; the API refuses to start.
 */
export function productionProblems(env: Env, context: ProductionContext = {}): { path: string; message: string }[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: { path: string; message: string }[] = [];
  if (env.JWT_ACCESS_SECRET.length < 32) {
    problems.push({ path: 'JWT_ACCESS_SECRET', message: 'must be at least 32 characters in production' });
  }
  for (const name of PRODUCTION_SECRETS) {
    const word = placeholderWord(env[name]);
    if (word) problems.push({ path: name, message: `looks like a placeholder ("${word}"): generate a random secret for production` });
  }
  // The e2e harness runs production mode against the local test database (root, often no
  // password); a server never runs inside Jest.
  if (!context.underTest) problems.push(...databaseCredentialProblems(env.DATABASE_URL));
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
  if (trustProxySetting(env.TRUST_PROXY) === true) {
    problems.push({
      path: 'TRUST_PROXY',
      message: 'must not be true in production: name the proxies (e.g. loopback), or anyone can forge their address (ADR-011)',
    });
  }
  if (env.ALERT_WEBHOOK_URL && !env.ALERT_WEBHOOK_URL.startsWith('https://')) {
    problems.push({ path: 'ALERT_WEBHOOK_URL', message: 'must be https:// in production: alerts carry error details' });
  }
  if (!isSealingKey(env.BACKUP_ENCRYPTION_KEY)) {
    problems.push({ path: 'BACKUP_ENCRYPTION_KEY', message: 'is required in production: 32 random bytes, base64 (backups leave the server)' });
  }
  if (env.EINVOICE_WORKER === 'on') {
    problems.push({
      path: 'EINVOICE_WORKER',
      message: 'must be off in production: e-invoices are sent by Cron (ADR-009 §15)',
    });
  }
  return problems;
}

/** A production database account: not root, with a password (the development default is root with none). */
function databaseCredentialProblems(databaseUrl: string): { path: string; message: string }[] {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return [{ path: 'DATABASE_URL', message: 'must be a mysql://user:password@host:port/database URL' }];
  }
  const problems: { path: string; message: string }[] = [];
  if (decodeURIComponent(url.username).toLowerCase() === 'root') {
    problems.push({ path: 'DATABASE_URL', message: 'must not use the root account in production: use the database user from the hosting panel' });
  }
  if (url.password === '') {
    problems.push({ path: 'DATABASE_URL', message: 'must have a password in production' });
  }
  return problems;
}

/**
 * NODE_ENV=test only inside a test run: Jest sets JEST_WORKER_ID (the e2e
 * suites spawn the built API with the whole environment, so it reaches them
 * too), or ALLOW_TEST_ENV=true for a deliberate manual run.
 */
function testEnvProblems(env: Env, underTest: boolean): string[] {
  if (env.NODE_ENV !== 'test' || underTest || env.ALLOW_TEST_ENV === 'true') return [];
  return ['NODE_ENV: test is only for test runs (it opens test-only routes): use production on a server, development locally'];
}

/** Express `trust proxy` from TRUST_PROXY: false, true, a hop count, or addresses and subnets. */
export function trustProxySetting(value: string): boolean | number | string {
  const v = value.trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * `runtime` is where JEST_WORKER_ID is read: the real process environment
 * only, never `config` (which ConfigModule merges with apps/api/.env), so a
 * JEST_WORKER_ID line in a .env file cannot switch the test exemptions on.
 */
export function validateEnv(
  config: Record<string, unknown>,
  runtime: { JEST_WORKER_ID?: string } = process.env,
): Env {
  // `NAME=` in a .env file means unset: its default applies, or "required".
  const given = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== ''));
  // Node hosting panels hand the app its port in PORT: listen there unless API_PORT says otherwise.
  if (given.API_PORT === undefined && given.PORT !== undefined) given.API_PORT = given.PORT;
  const result = envSchema.safeParse(given);
  // Jest sets JEST_WORKER_ID in every worker, and spawned e2e processes inherit it.
  const underTest = !!runtime.JEST_WORKER_ID;
  const issues = result.success
    ? [
        ...productionProblems(result.data, { underTest }).map((p) => `${p.path}: ${p.message}`),
        ...testEnvProblems(result.data, underTest),
      ]
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  if (!result.success || issues.length > 0) {
    throw new Error(`Invalid environment configuration: ${issues.join('; ')}`);
  }
  return result.data;
}

/** Whether /api/docs is served (ADR-010 §5). */
export function apiDocsEnabled(env: Pick<Env, 'API_DOCS' | 'NODE_ENV'>): boolean {
  // `API_DOCS=` reaches here as '' (ConfigService falls back to process.env): treat it as unset.
  return (env.API_DOCS || (env.NODE_ENV === 'production' ? 'off' : 'on')) === 'on';
}
