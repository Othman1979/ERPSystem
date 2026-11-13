import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { calendarDateIn, DocumentSupportService } from '../shared/document-support.service.js';
import { outstandingAmount } from '../shared/invoice-balance.js';
import { ReportsService } from '../journal/reports.service.js';
import { PartiesService } from '../parties/parties.service.js';
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

/** Today's calendar date at UTC midnight (the default "as of"; the web sends its local date). */
export function todayUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Whole days from `due` to `asOf`, both taken as calendar dates (UTC). */
export function daysOverdue(due: Date, asOf: Date): number {
  const d = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const a = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.round((a - d) / DAY_MS);
}

type Buckets = Record<AgingBucket, Decimal>;

const zeroBuckets = (): Buckets =>
  Object.fromEntries(AGING_BUCKETS.map((b) => [b, new Decimal(0)])) as Buckets;

/**
 * Ages the part of a party's balance that its invoices do not explain
 * (ADR-004 §7): residual = control-account balance − open invoices.
 *  - residual ≤ 0: unallocated receipts / payments, or credits beyond the
 *    invoices — nothing to age; it is reported as `unapplied`.
 *  - residual > 0: it is what is left of the party's opening-balance and
 *    manual-journal items, taken newest first (the oldest were settled
 *    first), each aged from its entry date. Any rest the items cannot cover
 *    is reported as `unapplied` too.
 */
export function ageResidual(
  residual: Decimal,
  items: { entryDate: Date; amount: Decimal }[],
  asOf: Date,
): { buckets: Buckets; unapplied: Decimal } {
  const buckets = zeroBuckets();
  if (residual.lte(0)) return { buckets, unapplied: residual };
  let left = residual;
  const newestFirst = [...items].sort((x, y) => y.entryDate.getTime() - x.entryDate.getTime());
  for (const item of newestFirst) {
    if (left.lte(0)) break;
    const take = Decimal.min(item.amount, left);
    const bucket = agingBucket(daysOverdue(item.entryDate, asOf));
    buckets[bucket] = buckets[bucket].plus(take);
    left = left.minus(take);
  }
  return { buckets, unapplied: left };
}

/**
 * Treasury reports (Phase 6): receivable/payable aging and cash/bank balances.
 * Invoices are read through the sales/purchases services, journal balances
 * through the journal reports service (module boundary).
 */
@Injectable()
export class TreasuryReportsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly sales: SalesInvoicesService,
    private readonly purchases: PurchaseInvoicesService,
    private readonly ledger: ReportsService,
    private readonly parties: PartiesService,
  ) {}

  /**
   * Aging as of a date (ADR-004 §7, updated). Per party:
   *  - every posted credit invoice dated ≤ asOf that still owes something
   *    then (grand total − credit returns dated ≤ asOf − allocations counted
   *    as of asOf, see `allocatedAsOf`), by days past its due date (invoice
   *    date when none);
   *  - plus the rest of its control-account balance (opening balances,
   *    manual entries, unallocated vouchers), see `ageResidual`.
   * `total` = the aged buckets; `balance` = total + unapplied = the party's
   * control-account balance as of the date, as in the trial balance.
   * Buckets: not due, 1–30, 31–60, 61–90, over 90 days.
   */
  async aging(partyType: 'CUSTOMER' | 'SUPPLIER', asOf = todayUtc()) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const mapping = await this.support.mappingAccounts(db, tenantId, companyId, [
      partyType === 'CUSTOMER' ? 'CUSTOMERS_CONTROL' : 'SUPPLIERS_CONTROL',
    ]);
    const controlAccountId = Object.values(mapping)[0];
    const documentType = partyType === 'CUSTOMER' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';
    const [creditInvoices, allocated, balances, items] = await Promise.all([
      partyType === 'CUSTOMER' ? this.sales.creditInvoicesAsOf(asOf) : this.purchases.creditInvoicesAsOf(asOf),
      this.allocatedAsOf(documentType, asOf),
      this.ledger.controlBalancesByParty(partyType, asOf, controlAccountId),
      this.ledger.openingAndManualItemsByParty(partyType, asOf, controlAccountId),
    ]);

    type PartyInfo = { id: bigint; code: string; nameAr: string; nameEn: string | null };
    const byParty = new Map<bigint, { party?: PartyInfo; buckets: Buckets; invoiced: Decimal }>();
    const entry = (id: bigint) => {
      const row = byParty.get(id) ?? { buckets: zeroBuckets(), invoiced: new Decimal(0) };
      byParty.set(id, row);
      return row;
    };

    for (const inv of creditInvoices) {
      const owed = outstandingAmount(inv.grandTotal, allocated.get(inv.id) ?? '0', inv.creditedAmount);
      if (owed.lte(0)) continue;
      const row = entry(inv.party.id);
      row.party = inv.party;
      const bucket = agingBucket(daysOverdue(inv.dueDate ?? inv.invoiceDate, asOf));
      row.buckets[bucket] = row.buckets[bucket].plus(owed);
      row.invoiced = row.invoiced.plus(owed);
    }
    for (const partyId of balances.keys()) entry(partyId);

    const unnamed = [...byParty.entries()].filter(([, r]) => !r.party).map(([id]) => id);
    for (const p of await this.parties.summaries(unnamed)) {
      const row = byParty.get(p.id);
      if (row) row.party = p;
    }

    const totals = { buckets: zeroBuckets(), unapplied: new Decimal(0), balance: new Decimal(0) };
    const rows: {
      party: PartyInfo;
      buckets: Buckets;
      total: Decimal;
      unapplied: Decimal;
      balance: Decimal;
    }[] = [];
    for (const [partyId, row] of byParty) {
      if (!row.party) continue; // a party of another company: never on this company's lines
      const balance = balances.get(partyId) ?? new Decimal(0);
      const rest = ageResidual(balance.minus(row.invoiced), items.get(partyId) ?? [], asOf);
      const buckets = zeroBuckets();
      for (const b of AGING_BUCKETS) buckets[b] = row.buckets[b].plus(rest.buckets[b]);
      const total = AGING_BUCKETS.reduce((s, b) => s.plus(buckets[b]), new Decimal(0));
      if (total.isZero() && rest.unapplied.isZero()) continue;
      rows.push({ party: row.party, buckets, total, unapplied: rest.unapplied, balance: total.plus(rest.unapplied) });
      for (const b of AGING_BUCKETS) totals.buckets[b] = totals.buckets[b].plus(buckets[b]);
      totals.unapplied = totals.unapplied.plus(rest.unapplied);
      totals.balance = totals.balance.plus(total.plus(rest.unapplied));
    }

    const fmt = (b: Buckets, unapplied: Decimal, balance: Decimal) => ({
      ...(Object.fromEntries(AGING_BUCKETS.map((k) => [k, b[k].toFixed(3)])) as Record<AgingBucket, string>),
      total: AGING_BUCKETS.reduce((s, k) => s.plus(b[k]), new Decimal(0)).toFixed(3),
      unapplied: unapplied.toFixed(3),
      balance: balance.toFixed(3),
    });

    return {
      partyType,
      asOf: asOf.toISOString().slice(0, 10),
      rows: rows
        .sort((x, y) => x.party.code.localeCompare(y.party.code))
        .map((r) => ({
          partyId: r.party.id.toString(),
          code: r.party.code,
          nameAr: r.party.nameAr,
          nameEn: r.party.nameEn,
          ...fmt(r.buckets, r.unapplied, r.balance),
        })),
      totals: fmt(totals.buckets, totals.unapplied, totals.balance),
    };
  }

  /**
   * Allocations per invoice counted as of `asOf`, summed per document (3 decimals).
   * An allocation counts when its voucher is dated on or before `asOf` and it is
   * either still active or was cancelled after `asOf`. A cancellation has no
   * business date, so its calendar date (in the company's timezone) stands in:
   * an allocation cancelled on or before `asOf` no longer counts from then on,
   * nor one whose voucher's reversal entry is dated on or before `asOf`.
   * An invoice dated after its voucher (an advance) is only listed from its own
   * date on, so the allocation counts from the later of the two.
   */
  private async allocatedAsOf(documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE', asOf: Date) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const company = await db.company.findFirst({ where: { id: companyId }, select: { timezone: true } });
    const timeZone = company?.timezone || 'Asia/Amman';
    const asOfIso = asOf.toISOString().slice(0, 10);
    const voucherDated = {
      OR: [{ receipt: { receiptDate: { lte: asOf } } }, { payment: { paymentDate: { lte: asOf } } }],
    };

    const [active, cancelled] = await Promise.all([
      db.allocation.groupBy({
        by: ['documentId'],
        where: { companyId, documentType, cancelledAt: null, ...voucherDated },
        _sum: { amount: true },
      }),
      // A calendar day in any zone (UTC-12 to UTC+14) starts within a day before asOf.
      db.allocation.findMany({
        where: {
          companyId,
          documentType,
          cancelledAt: { gte: new Date(asOf.getTime() - DAY_MS) },
          ...voucherDated,
        },
        select: {
          documentId: true,
          amount: true,
          cancelledAt: true,
          receipt: { select: { reversalEntryId: true } },
          payment: { select: { reversalEntryId: true } },
        },
      }),
    ]);

    // A voucher is reversed only once its allocations are cancelled, but its
    // reversal may be dated before the cancel: from that date the payment is
    // gone from the ledger, so its allocation stops counting too (review of PR #26).
    const reversalIds = cancelled
      .map((a) => a.receipt?.reversalEntryId ?? a.payment?.reversalEntryId ?? null)
      .filter((id): id is bigint => id !== null);
    const reversalDates = await this.ledger.entryDates(reversalIds);

    const totals = new Map<bigint, Decimal>(
      active.map((s) => [s.documentId, new Decimal(s._sum.amount?.toString() ?? '0')]),
    );
    for (const a of cancelled) {
      if (!a.cancelledAt || calendarDateIn(timeZone, a.cancelledAt) <= asOfIso) continue;
      const reversalId = a.receipt?.reversalEntryId ?? a.payment?.reversalEntryId ?? null;
      const reversedOn = reversalId !== null ? reversalDates.get(reversalId) : undefined;
      if (reversedOn && reversedOn.getTime() <= asOf.getTime()) continue;
      totals.set(a.documentId, (totals.get(a.documentId) ?? new Decimal(0)).plus(new Decimal(a.amount.toString())));
    }
    return new Map([...totals].map(([id, sum]) => [id, sum.toFixed(3)]));
  }

  /**
   * Balance of every cash box and bank account = its ledger account's posted
   * debit − credit — the same journal lines as the trial balance (Phase 6
   * acceptance: the two must agree). Cash/bank ledger accounts that no cash
   * box or bank record points at are listed too (kind ACCOUNT): vouchers can
   * post to them directly, so leaving them out would hide real money.
   */
  async cashBalances() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const accountSelect = { select: { id: true, code: true, nameAr: true, nameEn: true } } as const;
    const [boxes, banks, cashAccounts] = await Promise.all([
      db.cashBox.findMany({ where: { companyId }, include: { account: accountSelect }, orderBy: { code: 'asc' } }),
      db.bankAccount.findMany({ where: { companyId }, include: { account: accountSelect }, orderBy: { bankName: 'asc' } }),
      db.account.findMany({
        where: { companyId, isPostable: true, controlType: { in: ['CASH', 'BANK'] } },
        select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    const linked = new Set([...boxes, ...banks].map((x) => x.accountId));
    const unlinked = cashAccounts.filter((a) => !linked.has(a.id));
    const accountIds = [...linked, ...unlinked.map((a) => a.id)];
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
      ...unlinked.map(({ isActive, ...a }) => ({
        kind: 'ACCOUNT' as const,
        id: a.id.toString(),
        name: a.nameAr,
        isActive,
        account: a,
      })),
    ].map((r) => ({
      ...r,
      account: { ...r.account, id: r.account.id.toString() },
      balance: balanceOf(BigInt(r.account.id)).toFixed(3),
    }));
    return { rows, total: rows.reduce((s, r) => s.plus(r.balance), new Decimal(0)).toFixed(3) };
  }
}
