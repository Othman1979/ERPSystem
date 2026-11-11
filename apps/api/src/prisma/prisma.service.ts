import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import mariadb, { type Pool, type PoolConfig } from 'mariadb';
import type { Env } from '../common/config/env.validation.js';
import { tenantScopedPrisma } from './tenant-prisma.js';

function parseDatabaseUrl(url: string): PoolConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
    connectionLimit: 10,
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
