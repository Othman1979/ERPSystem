import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { ReportsService } from '../journal/reports.service.js';
import { PurchaseInvoicesService } from '../purchases/purchase-invoices.service.js';
import { PurchaseReturnsService } from '../purchases/purchase-returns.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';
import { SalesReturnsService } from '../sales/sales-returns.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { DocumentSummaryRow } from '../shared/document-summary.js';
import { ReportPeriods, utcDate } from './report-periods.service.js';

const FIELDS = [
  'salesBase',
  'salesTax',
  'salesReturnsBase',
  'salesReturnsTax',
  'outputBase',
  'outputTax',
  'purchasesBase',
  'purchasesTax',
  'purchaseReturnsBase',
  'purchaseReturnsTax',
  'inputBase',
  'inputTax',
  'payable',
] as const;
type Field = (typeof FIELDS)[number];
type Amounts = Record<Field, Decimal>;

const zero = (): Amounts => Object.fromEntries(FIELDS.map((f) => [f, new Decimal(0)])) as Amounts;
const fixed = (a: Amounts) => Object.fromEntries(FIELDS.map((f) => [f, a[f].toFixed(3)])) as Record<Field, string>;

/**
 * Sales-tax summary for a period (Phase 8), per (tax category, rate,
 * e-invoice code), from the posted documents' lines:
 *  - output = sales invoices − sales returns (each by its own date);
 *  - input = purchase invoices − purchase returns;
 *  - payable = output tax − input tax (negative: a refund position);
 *  - ledgerDifference = the period's movement on the OUTPUT_TAX (Cr − Dr) and
 *    INPUT_TAX (Dr − Cr) mapped accounts minus the document figures — zero
 *    unless tax was posted by hand (manual / opening entries).
 */
@Injectable()
export class TaxSummaryService {
  constructor(
    private readonly sales: SalesInvoicesService,
    private readonly salesReturns: SalesReturnsService,
    private readonly purchases: PurchaseInvoicesService,
    private readonly purchaseReturns: PurchaseReturnsService,
    private readonly ledger: ReportsService,
    private readonly support: DocumentSupportService,
    private readonly periods: ReportPeriods,
  ) {}

  async taxSummary(q: { from?: string; to?: string }) {
    const period = await this.periods.period(q);
    const range = { from: utcDate(period.from), to: utcDate(period.to) };
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const [si, sr, pi, pr, totals, mapping] = await Promise.all([
      this.sales.summary(range, 'tax'),
      this.salesReturns.summary(range, 'tax'),
      this.purchases.summary(range, 'tax'),
      this.purchaseReturns.summary(range, 'tax'),
      this.ledger.accountTotals({ from: period.from, to: period.to }),
      this.support.mappingAccounts(db, tenantId, companyId, ['OUTPUT_TAX', 'INPUT_TAX']),
    ]);

    const rows = new Map<string, { head: DocumentSummaryRow; a: Amounts }>();
    const add = (list: DocumentSummaryRow[], base: Field, tax: Field) => {
      for (const r of list) {
        const row = rows.get(r.key) ?? { head: r, a: zero() };
        rows.set(r.key, row);
        row.a[base] = row.a[base].plus(r.net);
        row.a[tax] = row.a[tax].plus(r.tax);
      }
    };
    add(si, 'salesBase', 'salesTax');
    add(sr, 'salesReturnsBase', 'salesReturnsTax');
    add(pi, 'purchasesBase', 'purchasesTax');
    add(pr, 'purchaseReturnsBase', 'purchaseReturnsTax');

    const sumAll = zero();
    const out = [...rows.values()].map(({ head, a }) => {
      a.outputBase = a.salesBase.minus(a.salesReturnsBase);
      a.outputTax = a.salesTax.minus(a.salesReturnsTax);
      a.inputBase = a.purchasesBase.minus(a.purchaseReturnsBase);
      a.inputTax = a.purchasesTax.minus(a.purchaseReturnsTax);
      a.payable = a.outputTax.minus(a.inputTax);
      for (const f of FIELDS) sumAll[f] = sumAll[f].plus(a[f]);
      return {
        key: head.key,
        taxCategoryId: head.ref?.id ?? null,
        code: head.ref?.code ?? null,
        nameAr: head.ref?.nameAr ?? null,
        nameEn: head.ref?.nameEn ?? null,
        rate: (head.taxRate ?? new Decimal(0)).toString(),
        einvoiceCode: head.einvoiceCode,
        ...fixed(a),
      };
    });
    out.sort((x, y) => new Decimal(y.rate).comparedTo(x.rate) || (x.code ?? '').localeCompare(y.code ?? ''));

    const movement = (accountId: bigint, side: 'credit' | 'debit') => {
      const t = totals.find((x) => x.account.id === accountId);
      if (!t) return new Decimal(0);
      return side === 'credit' ? t.credit.minus(t.debit) : t.debit.minus(t.credit);
    };
    const ledgerOutput = movement(mapping.OUTPUT_TAX, 'credit');
    const ledgerInput = movement(mapping.INPUT_TAX, 'debit');

    return {
      from: period.from,
      to: period.to,
      rows: out,
      totals: fixed(sumAll),
      ledger: { output: ledgerOutput.toFixed(3), input: ledgerInput.toFixed(3) },
      ledgerDifference: {
        output: ledgerOutput.minus(sumAll.outputTax).toFixed(3),
        input: ledgerInput.minus(sumAll.inputTax).toFixed(3),
      },
    };
  }
}
