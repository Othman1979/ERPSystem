import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { FiscalService } from '../accounting/fiscal.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';

/** yyyy-mm-dd → the calendar date at UTC midnight (how DATE columns come back). */
export const utcDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface ResolvedPeriod {
  from: string;
  to: string;
  /** The fiscal year the defaults came from (the one containing `to`, `from` or today). */
  fiscalYear: { id: string; code: string } | null;
}

/** Default dates for the Phase 8 reports: today in the company's timezone and its fiscal year. */
@Injectable()
export class ReportPeriods {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly fiscal: FiscalService,
  ) {}

  /** Today (yyyy-mm-dd) in `companies.timezone`. */
  async today(): Promise<string> {
    const { db } = this.support.tenant();
    return this.support.companyToday(db);
  }

  /**
   * from / to with defaults: both missing → the fiscal year containing
   * today; one missing → that end of the fiscal year containing the other.
   * With no fiscal year there, the calendar year. from > to is rejected.
   */
  async period(q: { from?: string; to?: string }): Promise<ResolvedPeriod> {
    if (q.from && q.to) {
      if (q.from > q.to) {
        throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: q.from, to: q.to });
      }
      const fy = await this.fiscal.yearContaining(utcDate(q.to));
      return { from: q.from, to: q.to, fiscalYear: fy ? { id: fy.id.toString(), code: fy.code } : null };
    }
    const anchor = q.to ?? q.from ?? (await this.today());
    const fy = await this.fiscal.yearContaining(utcDate(anchor));
    const from = q.from ?? (fy ? iso(fy.startDate) : `${anchor.slice(0, 4)}-01-01`);
    const to = q.to ?? (fy ? iso(fy.endDate) : `${anchor.slice(0, 4)}-12-31`);
    if (from > to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from, to });
    }
    return { from, to, fiscalYear: fy ? { id: fy.id.toString(), code: fy.code } : null };
  }

  /** Start of the fiscal year containing `asOf` (1 January when no fiscal year contains it). */
  async yearStart(asOf: string): Promise<{ start: string; fiscalYear: { id: string; code: string } | null }> {
    const fy = await this.fiscal.yearContaining(utcDate(asOf));
    return {
      start: fy ? iso(fy.startDate) : `${asOf.slice(0, 4)}-01-01`,
      fiscalYear: fy ? { id: fy.id.toString(), code: fy.code } : null,
    };
  }
}

/** The calendar day before yyyy-mm-dd. */
export function dayBefore(isoDay: string): string {
  const d = utcDate(isoDay);
  d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}
