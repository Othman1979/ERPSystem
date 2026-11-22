import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import type { RequestContext } from '../common/cls/cls.types.js';
import { PrismaService } from './prisma.service.js';

export interface TenantDatabaseEntry {
  tenantId: bigint | null;
  client: PrismaClient;
}

export interface TenantDatabaseList extends Array<TenantDatabaseEntry> {
  unavailable: bigint[];
}

export interface TenantJobResult<T> {
  tenantId: bigint;
  result: T;
}

@Injectable()
export class TenantFanoutService {
  // systemPrisma: tenant database routing metadata belongs to the control plane.
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async databases(opts: { tenantId?: bigint } = {}): Promise<TenantDatabaseList> {
    const entries: TenantDatabaseEntry[] = [];
    const unavailable: bigint[] = [];
    if (this.prisma.tenancyMode === 'shared') {
      entries.push({ tenantId: null, client: this.prisma.control() });
      return Object.assign(entries, { unavailable });
    }

    const rows = await this.prisma.control().tenantDatabase.findMany({
      where: opts.tenantId === undefined ? { state: 'ACTIVE' } : { tenantId: opts.tenantId },
      select: { tenantId: true },
      orderBy: { tenantId: 'asc' },
    });
    if (opts.tenantId !== undefined && rows.length === 0) {
      const tenant = await this.prisma.control().tenant.findUnique({ where: { id: opts.tenantId }, select: { id: true } });
      if (tenant) unavailable.push(opts.tenantId);
    }
    for (const row of rows) {
      try {
        await this.prisma.router.resolve(row.tenantId);
        entries.push({ tenantId: row.tenantId, client: this.prisma.forTenant(row.tenantId) });
      } catch (error) {
        if (!isUnavailableDatabase(error)) throw error;
        unavailable.push(row.tenantId);
      }
    }
    return Object.assign(entries, { unavailable });
  }

  async forEachTenant<T>(
    fn: (client: PrismaClient, tenantId: bigint) => Promise<T>,
  ): Promise<{ results: TenantJobResult<T>[]; unavailable: bigint[] }> {
    const tenants = await this.prisma.control().tenant.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const results: TenantJobResult<T>[] = [];
    const unavailable: bigint[] = [];
    for (const { id: tenantId } of tenants) {
      if (this.prisma.tenancyMode === 'isolated') {
        try {
          await this.prisma.router.resolve(tenantId);
        } catch (error) {
          if (!isUnavailableDatabase(error)) throw error;
          unavailable.push(tenantId);
          continue;
        }
      }
      const result = await this.cls.run(async () => {
        this.cls.set('tenantId', tenantId);
        this.cls.set('jobContext', true);
        return fn(this.prisma.forTenant(tenantId), tenantId);
      });
      results.push({ tenantId, result });
    }
    return { results, unavailable };
  }
}

function isUnavailableDatabase(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.code === ErrorCode.TENANT_MAINTENANCE || error.code === ErrorCode.TENANT_DB_NOT_FOUND)
  );
}
