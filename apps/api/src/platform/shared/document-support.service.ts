import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** yyyy-mm-dd of `now` on the wall clock of `timeZone`; UTC when the zone is unknown. */
export function calendarDateIn(timeZone: string, now = new Date()): string {
  try {
    // en-CA formats as yyyy-mm-dd.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Shared helpers for Phase 5 document services (tenant ctx, mappings, retry). */
@Injectable()
export class DocumentSupportService {
  constructor(private readonly prisma: PrismaService) {}

  tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  async companyId(db: ReturnType<PrismaService['forTenant']>): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  /** Today's calendar date (yyyy-mm-dd) in the company's timezone (`companies.timezone`). */
  async companyToday(db: ReturnType<PrismaService['forTenant']>, now = new Date()): Promise<string> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { timezone: true },
    });
    return calendarDateIn(company?.timezone ?? 'Asia/Amman', now);
  }

  userId(): bigint | undefined {
    return ClsServiceManager.getClsService<RequestContext>().get('userId');
  }

  async mappingAccounts(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    keys: string[],
  ): Promise<Record<string, bigint>> {
    const maps = await tx.accountMapping.findMany({
      where: { tenantId, companyId, mappingKey: { in: keys } },
    });
    const out: Record<string, bigint> = {};
    for (const m of maps) out[m.mappingKey] = m.accountId;
    for (const k of keys) {
      if (!out[k]) {
        throw new DomainError(ErrorCode.INTERNAL, `Account mapping ${k} is not configured`);
      }
    }
    return out;
  }

  async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = String((err as Error)?.message ?? '');
      if (code === 'P2034' || /deadlock|lock wait timeout/i.test(msg)) return fn();
      throw err;
    }
  }
}
