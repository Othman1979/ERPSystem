import { Injectable } from '@nestjs/common';
import { branchSql, branchWhere, hasAllBranches } from '../../common/branch/branch-context.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { calendarDateIn, DocumentSupportService } from '../shared/document-support.service.js';
import { Prisma } from '../../generated/prisma/client.js';
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
   *    as of asOf, see `allocationShiftAsOf`), by days past its due date
   *    (invoice date when none). Settled invoices are filtered out in SQL
   *    (DB-14), so a long history of paid invoices is not read;
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
    const shift = await this.allocationShiftAsOf(documentType, asOf);
    const [openInvoices, balances, items, moved] = await Promise.all([
      partyType === 'CUSTOMER'
        ? this.sales.openCreditInvoicesAsOf(asOf, shift)
        : this.purchases.openCreditInvoicesAsOf(asOf, shift),
      this.ledger.controlBalancesByParty(partyType, asOf, controlAccountId),
      this.ledger.openingAndManualItemsByParty(partyType, asOf, controlAccountId),
      this.crossBranchAllocationsAsOf(documentType, asOf),
    ]);
    // ADR-003 §21: an allocation settles its invoice's branch, whatever the
    // voucher's branch; the ledger balance (by line branch) is moved to match.
    for (const [partyId, delta] of moved) {
      balances.set(partyId, (balances.get(partyId) ?? new Decimal(0)).plus(delta));
    }

    type PartyInfo = { id: bigint; code: string; nameAr: string; nameEn: string | null };
    const byParty = new Map<bigint, { party?: PartyInfo; buckets: Buckets; invoiced: Decimal }>();
    const entry = (id: bigint) => {
      const row = byParty.get(id) ?? { buckets: zeroBuckets(), invoiced: new Decimal(0) };
      byParty.set(id, row);
      return row;
    };

    for (const inv of openInvoices) {
      const row = entry(inv.partyId);
      const bucket = agingBucket(daysOverdue(inv.dueDate ?? inv.invoiceDate, asOf));
      row.buckets[bucket] = row.buckets[bucket].plus(inv.owed);
      row.invoiced = row.invoiced.plus(inv.owed);
    }
    for (const partyId of balances.keys()) entry(partyId);

    // Names through the parties service (module boundary), for invoice and
    // journal-only parties alike.
    for (const p of await this.parties.summaries([...byParty.keys()])) {
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
   * ADR-003 §21 (owner, 2026-11-14): an allocation reduces the aging of its
   * INVOICE's branch, whatever branch its receipt or payment is on. The
   * control balance a restricted member sees is summed by journal-line
   * branch, where the voucher's whole amount sits on the voucher's branch.
   * For each allocation counted as of `asOf` whose voucher and invoice fall
   * on different sides of the caller's scope, its amount moves: back into
   * the balance when only the voucher is in scope (it settled an invoice the
   * caller does not see), out of it when only the invoice is. The
   * unallocated rest of a voucher stays on the voucher's branch.
   * Per party, in the balance's own sign (customers debit − credit,
   * suppliers credit − debit: either way a voucher lowers it). Empty for an
   * all-branch caller. "Counted as of" is `allocationShiftAsOf`'s rule, and
   * the invoice must be dated on or before `asOf` (an advance counts from
   * the later of the two dates).
   */
  private async crossBranchAllocationsAsOf(
    documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    asOf: Date,
  ): Promise<Map<bigint, Decimal>> {
    const moved = new Map<bigint, Decimal>();
    if (hasAllBranches()) return moved;
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const company = await db.company.findFirst({ where: { id: companyId }, select: { timezone: true } });
    const timeZone = company?.timezone || 'Asia/Amman';
    const asOfIso = asOf.toISOString().slice(0, 10);
    const invoices =
      documentType === 'SALES_INVOICE' ? await this.sales.invoiceRefsSql() : await this.purchases.invoiceRefsSql();
    const rows = await db.$queryRaw<
      { party_id: bigint; amount: Prisma.Decimal; cancelled_at: Date | null; reversal_entry_id: bigint | null; voucher_in: number | bigint }[]
    >`
      SELECT x.party_id, x.amount, x.cancelled_at, x.reversal_entry_id, ${branchSql(Prisma.raw('x.voucher_branch'))} AS voucher_in
        FROM (
          SELECT a.party_id, a.amount, a.cancelled_at,
                 CASE WHEN a.receipt_id IS NOT NULL THEN r.branch_id ELSE p.branch_id END AS voucher_branch,
                 CASE WHEN a.receipt_id IS NOT NULL THEN r.reversal_entry_id ELSE p.reversal_entry_id END AS reversal_entry_id,
                 d.branch_id AS invoice_branch
            FROM allocations a
            JOIN ${invoices} d ON d.id = a.document_id
            LEFT JOIN receipts r ON r.tenant_id = a.tenant_id AND r.id = a.receipt_id
            LEFT JOIN payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
           WHERE a.tenant_id = ${tenantId} AND a.company_id = ${companyId}
             AND a.document_type = ${documentType}
             AND d.doc_date <= ${asOfIso}
             AND COALESCE(r.receipt_date, p.payment_date) <= ${asOfIso}
             AND (a.cancelled_at IS NULL OR a.cancelled_at >= ${new Date(asOf.getTime() - DAY_MS)})
        ) x
       WHERE ${branchSql(Prisma.raw('x.voucher_branch'))} <> ${branchSql(Prisma.raw('x.invoice_branch'))}`;
    const cancelled = rows.filter((a) => a.cancelled_at !== null);
    const reversalDates = await this.ledger.entryDates([
      ...new Set(cancelled.map((a) => a.reversal_entry_id).filter((id): id is bigint => id !== null)),
    ]);
    for (const a of rows) {
      if (a.cancelled_at) {
        // Same rule as allocationShiftAsOf: cancelled (or its voucher reversed) by asOf → not counted.
        if (calendarDateIn(timeZone, a.cancelled_at) <= asOfIso) continue;
        const reversedOn = a.reversal_entry_id !== null ? reversalDates.get(a.reversal_entry_id) : undefined;
        if (reversedOn && reversedOn.getTime() <= asOf.getTime()) continue;
      }
      const amount = new Decimal(a.amount.toString());
      // Voucher in scope, invoice not: its line lowered this balance, add it back. Otherwise take it off.
      const delta = BigInt(a.voucher_in) === 1n ? amount : amount.negated();
      const partyId = BigInt(a.party_id);
      moved.set(partyId, (moved.get(partyId) ?? new Decimal(0)).plus(delta));
    }
    return moved;
  }

  /**
   * Per invoice: allocations counted now (the invoice's paid_amount, every
   * active allocation) minus allocations counted as of `asOf` (DB-14). The
   * invoice services subtract paid_amount in SQL and add this back.
   * An allocation counts as of `asOf` when its voucher is dated on or before
   * `asOf` and it is either still active or was cancelled after `asOf`. A
   * cancellation has no business date, so its calendar date (in the company's
   * timezone) stands in: an allocation cancelled on or before `asOf` no longer
   * counts from then on, nor one whose voucher's reversal entry is dated on or
   * before `asOf`. So the shift is
   *   + active allocations of vouchers dated after asOf (in paid_amount, not yet counted),
   *   − cancelled allocations that still count as of asOf (counted, no longer in paid_amount).
   * Both sets only hold allocations touched after `asOf`, so for today's aging
   * the map is nearly empty. An invoice dated after its voucher (an advance)
   * is only listed from its own date on, so the allocation counts from the
   * later of the two.
   */
  private async allocationShiftAsOf(
    documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    asOf: Date,
  ): Promise<Map<bigint, Decimal>> {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const company = await db.company.findFirst({ where: { id: companyId }, select: { timezone: true } });
    const timeZone = company?.timezone || 'Asia/Amman';
    const asOfIso = asOf.toISOString().slice(0, 10);
    const voucherDated = {
      OR: [{ receipt: { receiptDate: { lte: asOf } } }, { payment: { paymentDate: { lte: asOf } } }],
    };

    const [later, cancelled] = await Promise.all([
      db.allocation.groupBy({
        by: ['documentId'],
        where: {
          companyId,
          documentType,
          cancelledAt: null,
          OR: [{ receipt: { receiptDate: { gt: asOf } } }, { payment: { paymentDate: { gt: asOf } } }],
        },
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
    const reversalIds = [
      ...new Set(
        cancelled
          .map((a) => a.receipt?.reversalEntryId ?? a.payment?.reversalEntryId ?? null)
          .filter((id): id is bigint => id !== null),
      ),
    ];
    const reversalDates = await this.ledger.entryDates(reversalIds);

    const shift = new Map<bigint, Decimal>(
      later.map((s) => [s.documentId, new Decimal(s._sum.amount?.toString() ?? '0')]),
    );
    for (const a of cancelled) {
      if (!a.cancelledAt || calendarDateIn(timeZone, a.cancelledAt) <= asOfIso) continue;
      const reversalId = a.receipt?.reversalEntryId ?? a.payment?.reversalEntryId ?? null;
      const reversedOn = reversalId !== null ? reversalDates.get(reversalId) : undefined;
      if (reversedOn && reversedOn.getTime() <= asOf.getTime()) continue;
      shift.set(a.documentId, (shift.get(a.documentId) ?? new Decimal(0)).minus(new Decimal(a.amount.toString())));
    }
    return shift;
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
    const [boxes, banks, cashAccounts, allBoxes] = await Promise.all([
      // Cash boxes follow the caller's branches (ADR-003 §10); a box without a branch stays visible.
      db.cashBox.findMany({
        where: { companyId, AND: [branchWhere()] },
        include: { account: accountSelect },
        orderBy: { code: 'asc' },
      }),
      db.bankAccount.findMany({ where: { companyId }, include: { account: accountSelect }, orderBy: { bankName: 'asc' } }),
      db.account.findMany({
        where: { companyId, isPostable: true, controlType: { in: ['CASH', 'BANK'] } },
        select: { id: true, code: true, nameAr: true, nameEn: true, isActive: true },
        orderBy: { code: 'asc' },
      }),
      // Every box's ledger account, including other branches' boxes: such an account is
      // linked to a box and must not show up here as an "unlinked" account.
      db.cashBox.findMany({ where: { companyId }, select: { accountId: true } }),
    ]);
    const linked = new Set([...allBoxes, ...banks].map((x) => x.accountId));
    // Company-wide accounts with no box or bank behind them: only a member with every branch sees them (ADR-003 §10).
    const unlinked = hasAllBranches() ? cashAccounts.filter((a) => !linked.has(a.id)) : [];
    // Balances are computed for the rows shown only. Each balance is the account's whole
    // balance: journal lines are not filtered by branch (a box's balance stays complete).
    const accountIds = [...boxes, ...banks].map((x) => x.accountId).concat(unlinked.map((a) => a.id));
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
