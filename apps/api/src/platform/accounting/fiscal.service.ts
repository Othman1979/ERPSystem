import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DOCUMENT_TYPE_PREFIXES } from './chart-template.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';

/** Longest allowed fiscal year: twelve months (LEDGER-25). */
const MAX_YEAR_MONTHS = 12;

@Injectable()
export class FiscalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: ReturnType<PrismaService['forTenant']>): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  /**
   * Creates a fiscal year and its monthly periods + default document
   * sequences in ONE transaction (docs/BUILD_PLAN.md §8.5, §11).
   */
  async createYear(dto: { code: string; startDate: string; endDate: string }) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const userId = cls.get('userId');

    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (end <= start) {
      throw new DomainError(ErrorCode.VALIDATION, 'endDate must be after startDate');
    }

    // The last day of a year that starts on `start` and lasts MAX_YEAR_MONTHS.
    const maxEnd = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + MAX_YEAR_MONTHS, start.getUTCDate() - 1),
    );
    if (end > maxEnd) {
      throw new DomainError(ErrorCode.FISCAL_YEAR_TOO_LONG, 'A fiscal year is at most 12 months long', {
        maxEndDate: maxEnd.toISOString().slice(0, 10),
      });
    }

    const year = await db
      .$transaction(async (tx) => {
        // Lock the company row first: two concurrent creates must not both
        // pass the overlap check below.
        await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;

        // Reject overlapping years for the same company.
        const overlap = await tx.fiscalYear.findFirst({
          where: {
            companyId,
            OR: [{ startDate: { lte: end }, endDate: { gte: start } }],
          },
        });
        if (overlap) {
          throw new DomainError(ErrorCode.FISCAL_YEAR_OVERLAP, 'Fiscal year overlaps an existing year');
        }

        const y = await tx.fiscalYear.create({
          data: {
            tenantId,
            companyId,
            code: dto.code,
            startDate: start,
            endDate: end,
            createdBy: userId ?? null,
          },
        });

        // Monthly periods clipped to the year bounds.
        const periods: { periodNo: number; startDate: Date; endDate: Date }[] = [];
        const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
        let no = 1;
        while (cursor <= end) {
          const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
          const pStart = cursor < start ? start : cursor;
          const pEnd = monthEnd > end ? end : monthEnd;
          // Clone — cursor is mutated each iteration and must not be shared.
          periods.push({
            periodNo: no++,
            startDate: new Date(pStart),
            endDate: new Date(pEnd),
          });
          cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        }
        await tx.fiscalPeriod.createMany({
          data: periods.map((p) => ({ tenantId, fiscalYearId: y.id, ...p })),
        });

        // Default document sequences for this fiscal year.
        const yearCode = y.code;
        await tx.documentSequence.createMany({
          data: Object.entries(DOCUMENT_TYPE_PREFIXES).map(([documentType, prefix]) => ({
            tenantId,
            companyId,
            documentType,
            fiscalYearId: y.id,
            prefix: `${prefix}-${yearCode}`,
            nextNumber: 1,
            padding: 6,
          })),
        });
        return y;
      }, POSTING_TX_OPTIONS)
      .catch((err: unknown) => {
        // The unique key on (company, code) is the only one a new year can hit.
        if ((err as { code?: string }).code === 'P2002') {
          throw new DomainError(ErrorCode.DUPLICATE_CODE, 'Fiscal year code already exists', {
            code: dto.code,
          });
        }
        throw err;
      });

    await this.audit.log({
      action: 'fiscal_year.create',
      entityType: 'fiscal_year',
      entityId: year.id,
      after: { code: dto.code, startDate: dto.startDate, endDate: dto.endDate },
    });
    return this.getYear(year.id);
  }

  async listYears() {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.fiscalYear.findMany({
      where: { companyId },
      include: { _count: { select: { periods: true } } },
      orderBy: { startDate: 'desc' },
    });
  }

  async getYear(id: bigint) {
    const { db } = this.tenant();
    const year = await db.fiscalYear.findFirst({
      where: { id },
      include: {
        periods: { orderBy: { periodNo: 'asc' } },
        _count: { select: { periods: true } },
      },
    });
    if (!year) throw DomainError.notFound('FiscalYear', id.toString());
    return year;
  }

  /**
   * The company's fiscal year whose start..end range contains `date` (a
   * calendar date at UTC midnight), or null. Reports use it for the default
   * period and the balance sheet's year start (Phase 8).
   */
  async yearContaining(date: Date) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.fiscalYear.findFirst({
      where: { companyId, startDate: { lte: date }, endDate: { gte: date } },
      select: { id: true, code: true, startDate: true, endDate: true, status: true },
    });
  }

  /**
   * Closes (or reopens) a whole fiscal year: every period of it, and the
   * year's own status (ADR-008 §7). Posting checks the periods, so a closed
   * year takes no document; nothing is posted or reversed (no closing entry,
   * §8.5). fiscal.close permission enforced at the controller.
   */
  async setYearStatus(yearId: bigint, status: 'OPEN' | 'CLOSED') {
    const { tenantId, db } = this.tenant();
    const year = await db.fiscalYear.findFirst({ where: { id: yearId }, select: { id: true, code: true, status: true } });
    if (!year) throw DomainError.notFound('FiscalYear', yearId.toString());
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    const changed = await db.$transaction(async (tx) => {
      // Lock every period of the year before writing. Postings hold a shared
      // lock on their period until COMMIT, so this waits for in-flight postings
      // (DB-20). closedAt is taken after the lock.
      await tx.$queryRaw`SELECT id FROM fiscal_periods WHERE tenant_id = ${tenantId} AND fiscal_year_id = ${yearId} ORDER BY id FOR UPDATE`;
      const closedAt = new Date();
      const periods = await tx.fiscalPeriod.updateMany({
        where: { fiscalYearId: yearId, status: status === 'CLOSED' ? 'OPEN' : 'CLOSED' },
        data:
          status === 'CLOSED'
            ? { status, closedAt, closedBy: userId }
            : { status, closedAt: null, closedBy: null },
      });
      await tx.fiscalYear.update({ where: { id: yearId }, data: { status } });
      return periods.count;
    }, POSTING_TX_OPTIONS);
    await this.audit.log({
      action: status === 'CLOSED' ? 'fiscal_year.close' : 'fiscal_year.open',
      entityType: 'fiscal_year',
      entityId: yearId,
      before: { status: year.status },
      after: { status, periodsChanged: changed },
    });
    return this.getYear(yearId);
  }

  /** Close/reopen a period — fiscal.close permission enforced at controller. */
  async setPeriodStatus(periodId: bigint, status: 'OPEN' | 'CLOSED') {
    const { tenantId, db } = this.tenant();
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;

    const result = await db.$transaction(async (tx) => {
      // Postings hold a shared lock on their period until COMMIT
      // (PostingService.resolveOpenPeriod), so the close waits for in-flight
      // postings and no posting lands in a period after it closed (DB-20).
      const rows = await tx.$queryRaw<{ id: bigint; status: string; fiscal_year_id: bigint }[]>`SELECT id, status, fiscal_year_id FROM fiscal_periods WHERE tenant_id = ${tenantId} AND id = ${periodId} FOR UPDATE`;
      const locked = rows[0];
      if (!locked) throw DomainError.notFound('FiscalPeriod', periodId.toString());

      const before = locked.status;
      if (before === status) {
        const unchanged = await tx.fiscalPeriod.findFirst({ where: { id: periodId } });
        if (!unchanged) throw DomainError.notFound('FiscalPeriod', periodId.toString());
        return { changed: false, before, period: unchanged };
      }

      // Read the clock only after the lock, so closedAt is the real close time.
      const closedAt = new Date();
      const updated = await tx.fiscalPeriod.update({
        where: { id: periodId },
        data:
          status === 'CLOSED'
            ? { status, closedAt, closedBy: userId }
            : { status, closedAt: null, closedBy: null },
      });
      // The year follows its periods: closed once all are closed, open again
      // as soon as one reopens.
      const stillOpen = await tx.fiscalPeriod.count({
        where: { fiscalYearId: locked.fiscal_year_id, status: 'OPEN' },
      });
      await tx.fiscalYear.update({
        where: { id: locked.fiscal_year_id },
        data: { status: stillOpen > 0 ? 'OPEN' : 'CLOSED' },
      });
      return { changed: true, before, period: updated };
    }, POSTING_TX_OPTIONS);

    if (result.changed) {
      await this.audit.log({
        action: status === 'CLOSED' ? 'fiscal_period.close' : 'fiscal_period.open',
        entityType: 'fiscal_period',
        entityId: periodId,
        before: { status: result.before },
        after: { status },
      });
    }
    return result.period;
  }

  async listSequences(fiscalYearId?: bigint) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.documentSequence.findMany({
      where: { companyId, ...(fiscalYearId ? { fiscalYearId } : {}) },
      orderBy: [{ documentType: 'asc' }],
    });
  }
}
