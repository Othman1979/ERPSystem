import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import mariadb, { type Pool, type PoolConfig } from 'mariadb';
import type { Env } from '../common/config/env.validation.js';
import { tenantScopedPrisma } from './tenant-prisma.js';

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

export function parseDatabaseUrl(url: string): PoolConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    connectionLimit: 10,
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
    this.pool = mariadb.createPool(parseDatabaseUrl(databaseUrl));
    this.client = new PrismaClient({ adapter: new PrismaMariaDb(this.pool) });
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
