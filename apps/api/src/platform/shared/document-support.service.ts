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

const RETRIES = 3;

/** A deadlock or lock wait timeout: the transaction rolled back and can run again. */
export function isLockConflict(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = String((err as Error)?.message ?? '');
  return code === 'P2034' || /deadlock|lock wait timeout|\b(?:1213|1205)\b/i.test(msg);
}

/** See DocumentSupportService.withRetry; also used by the stock document services. */
export async function retryOnLockConflict<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isLockConflict(err)) throw err;
      if (attempt >= RETRIES) {
        throw new DomainError(ErrorCode.CONFLICT, 'The document is busy with another posting; try again');
      }
      await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 80) * (attempt + 1)));
    }
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

  /** Company setting: invoice prices are entered including tax (ADR-017). */
  async pricesIncludeTax(db: ReturnType<PrismaService['forTenant']>): Promise<boolean> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { pricesIncludeTax: true },
    });
    return company?.pricesIncludeTax ?? false;
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

  /**
   * Retries a posting transaction that lost a lock race: a deadlock (1213)
   * or a lock wait timeout (1205), surfaced by Prisma as P2034 or in the
   * message. Up to 3 retries with a short random backoff, then 409 CONFLICT
   * instead of a 500 (TRADE-05). P2028 (transaction timeout) is never
   * retried: COMMIT may already have run (transaction-options.ts).
   */
  withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retryOnLockConflict(fn);
  }
}
