import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import mariadb, { type Pool, type PoolConfig } from 'mariadb';
import type { Env } from '../common/config/env.validation.js';
import { tenantScopedPrisma } from './tenant-prisma.js';
import { POSTING_TX_OPTIONS } from './transaction-options.js';

/**
 * Run on every new connection, before it is used. MariaDB 11.6.2 turned
 * innodb_snapshot_isolation ON by default: in REPEATABLE READ a locking read
 * (SELECT ... FOR UPDATE) of a row changed after the transaction's first read
 * then fails with 1020 "Record has changed since last read". Posting reads
 * (fiscal year, period) and then locks (document sequence, stock balances)
 * by design (CLAUDE.md: explicit FOR UPDATE), so two concurrent postings
 * would fail instead of waiting. OFF restores the pre-11.6 behaviour the
 * locking was written for. The executable comment runs only on MariaDB
 * 11.6.2 and later (where the variable exists); older MariaDB and MySQL see
 * just `SET @erp_si = 0`, which never fails.
 */
export const SESSION_INIT_SQL = 'SET @erp_si = 0 /*M!110602 , SESSION innodb_snapshot_isolation = OFF */';

/** Pool limits from config (DB_POOL_SIZE, DB_POOL_ACQUIRE_TIMEOUT_MS; DB-07). */
export interface PoolLimits {
  size: number;
  acquireTimeoutMs: number;
}

/**
 * Driver connect timeout (PLAT-06). Deliberately no `socketTimeout`: in the
 * mariadb driver it is a socket IDLE timer set once at connect, not a cap per
 * query. It would kill every pooled connection idle that long (the pool keeps
 * them 30 min), and any single statement silent that long: tenant purge's
 * 120 s transaction, an all-tenant integrity check. Postings are capped by
 * POSTING_TX_OPTIONS (30 s) instead.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** A Cron command's pool when DB_POOL_SIZE is not given (jobs/cli.ts, DB-07). */
export const JOB_POOL_SIZE = 2;

/** The config schema's defaults (common/config/env.validation.ts). */
export const DEFAULT_POOL_LIMITS: PoolLimits = { size: 10, acquireTimeoutMs: 10_000 };

export function parseDatabaseUrl(url: string, limits: PoolLimits = DEFAULT_POOL_LIMITS): PoolConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    // A posting holds one connection for its whole transaction. Each process
    // (the API, every Cron command) has its own pool: size them together
    // against the host's max_user_connections.
    connectionLimit: limits.size,
    // How long a query waits for a free connection before it fails.
    acquireTimeout: limits.acquireTimeoutMs,
    // PLAT-06: a database that does not accept the connection fails within 10 s.
    connectTimeout: CONNECT_TIMEOUT_MS,
    initSql: SESSION_INIT_SQL,
  };
}

/**
 * Prisma 7's generated client uses a generic constructor signature, so
 * `class X extends PrismaClient` loses the instance type under NodeNext.
 * Composition keeps full type safety.
 *
 * `client` is the UNRESTRICTED (system) client. Business modules must use
 * `forTenant()`; direct `client` usage is reserved for the platform module
 * and scheduled jobs and must carry a justification comment (BUILD_PLAN §5.3).
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;
  private readonly pool: Pool;

  constructor(config: ConfigService<Env, true>) {
    const databaseUrl = config.get('DATABASE_URL', { infer: true });
    this.pool = mariadb.createPool(
      parseDatabaseUrl(databaseUrl, {
        size: config.get('DB_POOL_SIZE', { infer: true }),
        acquireTimeoutMs: config.get('DB_POOL_ACQUIRE_TIMEOUT_MS', { infer: true }),
      }),
    );
    // Default for every interactive transaction; posting services also pass
    // POSTING_TX_OPTIONS explicitly (guarded by test/static/posting-transactions.spec.ts).
    this.client = new PrismaClient({
      adapter: new PrismaMariaDb(this.pool),
      transactionOptions: POSTING_TX_OPTIONS,
    });
  }

  /** Tenant-scoped client: auto-injects tenant_id from arg or CLS context. */
  forTenant(tenantId?: bigint): PrismaClient {
    return tenantScopedPrisma(this.client, tenantId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
    // The adapter does not own the pool we gave it: end it too, or its open
    // connections keep the process alive (one-shot Cron jobs never exit).
    await this.pool.end();
  }
}
