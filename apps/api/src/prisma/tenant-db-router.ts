import { Logger } from '@nestjs/common';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { openSecret } from '../common/crypto/secret-box.js';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import mariadb, { type Pool, type PoolConfig } from 'mariadb';
import { POSTING_TX_OPTIONS } from './transaction-options.js';

export interface TenantDbRouterOptions {
  mode: 'shared' | 'isolated';
  poolSize: number;
  idleMs: number;
  maxPools: number;
  stateTtlMs: number;
  secretKey?: string;
  acquireTimeoutMs: number;
  connectTimeoutMs: number;
  collation: string;
  initSql: string[];
}

interface TenantDbCredentials {
  host: string;
  port: number;
  databaseName: string;
  dbUser: string;
  password: string;
}

type TenantDbFactoryOptions = Pick<
  TenantDbRouterOptions,
  'poolSize' | 'acquireTimeoutMs' | 'connectTimeoutMs' | 'collation' | 'initSql'
>;

interface TenantDbConnection {
  client: PrismaClient;
  pool: Pick<Pool, 'end'>;
}

export type TenantDbFactory = (credentials: TenantDbCredentials, options: TenantDbFactoryOptions) => TenantDbConnection;

interface PoolEntry extends TenantDbConnection {
  fingerprint: string;
  validatedAt: number;
  lastUsedAt: number;
}

function connectionFingerprint(database: {
  host: string;
  port: number;
  databaseName: string;
  dbUser: string;
  passwordSealed: string;
}): string {
  return [database.host, database.port, database.databaseName, database.dbUser, database.passwordSealed].join('\0');
}

export function createTenantDbConnection(
  credentials: TenantDbCredentials,
  options: TenantDbFactoryOptions,
): TenantDbConnection {
  const poolConfig: PoolConfig = {
    host: credentials.host,
    port: credentials.port,
    user: credentials.dbUser,
    password: credentials.password,
    database: credentials.databaseName,
    connectionLimit: options.poolSize,
    acquireTimeout: options.acquireTimeoutMs,
    connectTimeout: options.connectTimeoutMs,
    collation: options.collation,
    initSql: options.initSql,
  };
  const pool = mariadb.createPool(poolConfig);
  const client = new PrismaClient({
    adapter: new PrismaMariaDb(pool),
    transactionOptions: POSTING_TX_OPTIONS,
  });
  return { client, pool };
}

export class TenantDbRouter {
  private readonly logger = new Logger(TenantDbRouter.name);
  private readonly entries = new Map<bigint, PoolEntry>();
  private readonly pending = new Map<bigint, Promise<void>>();
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly control: PrismaClient,
    private readonly options: TenantDbRouterOptions,
    private readonly factory: TenantDbFactory = createTenantDbConnection,
  ) {
    this.sweepTimer = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweepTimer.unref();
  }

  async resolve(tenantId: bigint): Promise<void> {
    if (this.options.mode === 'shared') return;
    if (this.closed) {
      throw new DomainError(ErrorCode.TENANT_DB_NOT_RESOLVED, 'Tenant database router is closed');
    }

    const now = Date.now();
    const cached = this.entries.get(tenantId);
    if (cached && now - cached.validatedAt < this.options.stateTtlMs) {
      this.touch(tenantId, cached, now);
      return;
    }

    const current = this.pending.get(tenantId);
    if (current) {
      await current;
      const entry = this.entries.get(tenantId);
      if (entry) this.touch(tenantId, entry, Date.now());
      return;
    }

    const resolution = this.resolveIsolated(tenantId).finally(() => {
      this.pending.delete(tenantId);
    });
    this.pending.set(tenantId, resolution);
    await resolution;
  }

  client(tenantId: bigint): PrismaClient {
    if (this.options.mode === 'shared') return this.control;
    const entry = this.entries.get(tenantId);
    if (!entry) {
      throw new DomainError(ErrorCode.TENANT_DB_NOT_RESOLVED, 'Resolve the tenant database before using it');
    }
    this.touch(tenantId, entry, Date.now());
    return entry.client;
  }

  async invalidate(tenantId: bigint): Promise<void> {
    await this.dropEntry(tenantId);
  }

  async sweepIdle(): Promise<void> {
    if (this.closed) return;
    const now = Date.now();
    const expired = [...this.entries.entries()]
      .filter(([, entry]) => now - entry.lastUsedAt > this.options.idleMs)
      .map(([tenantId]) => tenantId);
    await Promise.all(expired.map((tenantId) => this.dropEntry(tenantId)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.entries.keys()].map((tenantId) => this.dropEntry(tenantId)));
  }

  private async resolveIsolated(tenantId: bigint): Promise<void> {
    const database = await this.control.tenantDatabase.findUnique({ where: { tenantId } });
    if (!database) {
      await this.dropEntry(tenantId);
      throw new DomainError(ErrorCode.TENANT_DB_NOT_FOUND, 'No database is configured for this tenant');
    }
    if (database.state !== 'ACTIVE') {
      await this.dropEntry(tenantId);
      throw new DomainError(ErrorCode.TENANT_MAINTENANCE, 'Tenant database is not active');
    }

    const fingerprint = connectionFingerprint(database);
    const cached = this.entries.get(tenantId);
    const now = Date.now();
    if (cached && cached.fingerprint === fingerprint) {
      cached.validatedAt = now;
      this.touch(tenantId, cached, now);
      return;
    }
    if (cached) await this.dropEntry(tenantId);
    if (this.closed) return;

    const connection = this.factory(
      {
        host: database.host,
        port: database.port,
        databaseName: database.databaseName,
        dbUser: database.dbUser,
        password: openSecret(database.passwordSealed, this.options.secretKey),
      },
      {
        poolSize: this.options.poolSize,
        acquireTimeoutMs: this.options.acquireTimeoutMs,
        connectTimeoutMs: this.options.connectTimeoutMs,
        collation: this.options.collation,
        initSql: this.options.initSql,
      },
    );
    this.entries.set(tenantId, { ...connection, fingerprint, validatedAt: now, lastUsedAt: now });
    await this.evictExcess();
  }

  private touch(tenantId: bigint, entry: PoolEntry, now: number): void {
    entry.lastUsedAt = now;
    this.entries.delete(tenantId);
    this.entries.set(tenantId, entry);
  }

  private async evictExcess(): Promise<void> {
    while (this.entries.size > this.options.maxPools) {
      const now = Date.now();
      const candidate = [...this.entries.entries()]
        .filter(([, entry]) => now - entry.lastUsedAt >= 30_000)
        .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!candidate) {
        this.logger.warn('Tenant database pool cap exceeded; no pool has been idle for at least 30 seconds');
        return;
      }
      await this.dropEntry(candidate[0]);
    }
  }

  private async dropEntry(tenantId: bigint): Promise<void> {
    const entry = this.entries.get(tenantId);
    if (!entry) return;
    this.entries.delete(tenantId);
    try {
      await entry.client.$disconnect();
    } catch {
      this.logger.warn('Failed to disconnect a tenant Prisma client');
    }
    try {
      await entry.pool.end();
    } catch {
      this.logger.warn('Failed to close a tenant database pool');
    }
  }
}
