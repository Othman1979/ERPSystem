import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

export const YEAR_CLOSING_DRAFT_TYPES = [
  'JOURNAL_ENTRY',
  'STOCK_ADJUSTMENT',
  'STOCK_TRANSFER',
  'STOCK_COUNT',
  'SALES_INVOICE',
  'PURCHASE_INVOICE',
  'SALES_RETURN',
  'PURCHASE_RETURN',
  'GOODS_NOTE',
  'RECEIPT',
  'PAYMENT',
  'CASH_TRANSFER',
  'PURCHASE_REQUEST',
  'PURCHASE_QUOTE',
  'PURCHASE_ORDER',
  'ISSUE_REQUEST',
  'SALES_QUOTE',
  'SALES_ORDER',
  'PRODUCTION_VOUCHER',
  'PAYROLL_RUN',
  'PAYROLL_SETTLEMENT',
] as const;

export type YearClosingDraftType = (typeof YEAR_CLOSING_DRAFT_TYPES)[number];

export interface YearClosingDraft {
  type: YearClosingDraftType;
  id: string;
  date: string;
  reference: string | null;
  description: string | null;
}

export type YearClosingDraftReader = (
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  companyId: bigint,
  from: Date,
  to: Date,
) => Promise<YearClosingDraft[]>;

export function yearClosingDraft(
  type: YearClosingDraftType,
  id: bigint,
  date: Date,
  reference: string | null,
  description: string | null,
): YearClosingDraft {
  return {
    type,
    id: id.toString(),
    date: date.toISOString().slice(0, 10),
    reference,
    description: description?.trim() || null,
  };
}

export function yearClosingDraftText(...values: (string | null | undefined)[]): string | null {
  return values.find((value) => value?.trim())?.trim() ?? null;
}

@Injectable()
export class YearClosingDraftRegistry {
  private readonly readers = new Map<YearClosingDraftType, YearClosingDraftReader>();

  register(type: YearClosingDraftType, reader: YearClosingDraftReader): void {
    if (this.readers.has(type)) {
      throw new DomainError(ErrorCode.INTERNAL, `Year-closing draft reader already registered: ${type}`);
    }
    this.readers.set(type, reader);
  }

  async list(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    from: Date,
    to: Date,
  ): Promise<YearClosingDraft[]> {
    const missing = YEAR_CLOSING_DRAFT_TYPES.filter((type) => !this.readers.has(type));
    if (missing.length > 0) {
      throw new DomainError(ErrorCode.INTERNAL, `Year-closing draft readers not registered: ${missing.join(', ')}`);
    }
    const drafts = await Promise.all(
      YEAR_CLOSING_DRAFT_TYPES.map((type) => this.readers.get(type)!(tx, tenantId, companyId, from, to)),
    );
    return drafts
      .flat()
      .sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  }
}
