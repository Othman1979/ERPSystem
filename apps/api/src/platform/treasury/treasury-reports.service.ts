import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';
import { PurchaseInvoicesService } from '../purchases/purchase-invoices.service.js';

export const AGING_BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days past due (≤ 0 means not yet due) → aging bucket. */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

/** Whole days from `due` to `asOf`, both taken as calendar dates (UTC). */
export function daysOverdue(due: Date, asOf: Date): number {
  const d = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const a = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.round((a - d) / DAY_MS);
}

/**
 * Treasury reports (Phase 6): receivable/payable aging and cash/bank balances.
 * Invoices are read through the sales/purchases services (module boundary).
 */
@Injectable()
export class TreasuryReportsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly sales: SalesInvoicesService,
    private readonly purchases: PurchaseInvoicesService,
  ) {}

  /**
   * Aging as of today: every posted credit invoice that still owes something,
   * by days past its due date (invoice date when none), summed per party.
   * Buckets: not due, 1–30, 31–60, 61–90, over 90 days.
   */
  async aging(partyType: 'CUSTOMER' | 'SUPPLIER', asOf = new Date()) {
    const invoices =
      partyType === 'CUSTOMER' ? await this.sales.openCreditInvoices() : await this.purchases.openCreditInvoices();

    const zero = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, new Decimal(0)])) as Record<AgingBucket, Decimal>;
    const byParty = new Map<
      string,
      { party: { id: bigint; code: string; nameAr: string; nameEn: string | null }; buckets: Record<AgingBucket, Decimal> }
    >();
    const totals = zero();

    for (const inv of invoices) {
      const bucket = agingBucket(daysOverdue(inv.dueDate ?? inv.invoiceDate, asOf));
      const amount = new Decimal(inv.outstanding);
      const key = inv.party.id.toString();
      const row = byParty.get(key) ?? { party: inv.party, buckets: zero() };
      row.buckets[bucket] = row.buckets[bucket].plus(amount);
      byParty.set(key, row);
      totals[bucket] = totals[bucket].plus(amount);
    }

    const fmt = (b: Record<AgingBucket, Decimal>) => {
      const total = AGING_BUCKETS.reduce((s, k) => s.plus(b[k]), new Decimal(0));
      return {
        ...(Object.fromEntries(AGING_BUCKETS.map((k) => [k, b[k].toFixed(3)])) as Record<AgingBucket, string>),
        total: total.toFixed(3),
      };
    };

    return {
      partyType,
      asOf: asOf.toISOString().slice(0, 10),
      rows: [...byParty.values()]
        .sort((x, y) => x.party.code.localeCompare(y.party.code))
        .map((r) => ({
          partyId: r.party.id.toString(),
          code: r.party.code,
          nameAr: r.party.nameAr,
          nameEn: r.party.nameEn,
          ...fmt(r.buckets),
        })),
      totals: fmt(totals),
    };
  }

  /**
   * Balance of every cash box and bank account = its ledger account's posted
   * debit − credit — the same journal lines as the trial balance (Phase 6
   * acceptance: the two must agree).
   */
  async cashBalances() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const [boxes, banks] = await Promise.all([
      db.cashBox.findMany({
        where: { companyId },
        include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
        orderBy: { code: 'asc' },
      }),
      db.bankAccount.findMany({
        where: { companyId },
        include: { account: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
        orderBy: { bankName: 'asc' },
      }),
    ]);
    const accountIds = [...new Set([...boxes, ...banks].map((x) => x.accountId))];
    const sums = accountIds.length
      ? await db.journalLine.groupBy({
          by: ['accountId'],
          where: { accountId: { in: accountIds }, entry: { companyId, status: 'POSTED' } },
          _sum: { debit: true, credit: true },
        })
      : [];
    const balanceOf = (accountId: bigint) => {
      const s = sums.find((x) => x.accountId === accountId);
      return new Decimal(s?._sum.debit?.toString() ?? '0').minus(s?._sum.credit?.toString() ?? '0');
    };

    const rows = [
      ...boxes.map((b) => ({ kind: 'CASH_BOX' as const, id: b.id.toString(), name: b.name, isActive: b.isActive, account: b.account })),
      ...banks.map((b) => ({ kind: 'BANK_ACCOUNT' as const, id: b.id.toString(), name: b.bankName, isActive: b.isActive, account: b.account })),
    ].map((r) => ({
      ...r,
      account: { ...r.account, id: r.account.id.toString() },
      balance: balanceOf(BigInt(r.account.id)).toFixed(3),
    }));
    return { rows, total: rows.reduce((s, r) => s.plus(r.balance), new Decimal(0)).toFixed(3) };
  }
}
