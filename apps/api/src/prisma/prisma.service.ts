import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import mariadb, { type PoolConfig } from 'mariadb';
import type { Env } from '../common/config/env.validation.js';

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
 * Composition keeps full type safety; tenant/system scoped clients will be
 * built on top of `client` in Phase 1 (docs/BUILD_PLAN.md 5.3).
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(config: ConfigService<Env, true>) {
    const databaseUrl = config.get('DATABASE_URL', { infer: true });
    const pool = mariadb.createPool(parseDatabaseUrl(databaseUrl));
    this.client = new PrismaClient({ adapter: new PrismaMariaDb(pool) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
