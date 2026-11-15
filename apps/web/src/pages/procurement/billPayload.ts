import type { BillableLineDto, BillLineDto, BillPurchaseOrderDto, PurchaseOrderBillableDto } from '@erp/api-client';
import Decimal from 'decimal.js';
import { dec, toDecimal } from '../../format/number';

/**
 * Billing a purchase order from its receipts (ADR-026). Pure functions only:
 * the modal holds the editable rows, these build what the server takes and
 * decide which rows need the price-difference approval. Every amount and
 * quantity stays a decimal string; the server recomputes all totals.
 */

/** One editable line of the bill: the receipt line it bills and the invoice price. */
export interface BillRow {
  grnLineId: string;
  /** Whether the line is part of this invoice. */
  selected: boolean;
  /** Base-unit quantity to bill; a decimal string. */
  qty: string;
  /** Invoice price per base unit, up to 6 decimals. */
  unitCost: string;
  /** Invoice discount in percent, up to 4 decimals. */
  discountPct: string;
}

/** Header fields of the bill, as the form holds them. Dates are 'YYYY-MM-DD'. */
export interface BillHeaderForm {
  invoiceDate: string;
  paymentType: 'CASH' | 'CREDIT';
  /** Required when paymentType is CASH. */
  cashAccountId?: string;
  supplierInvoiceNo?: string;
  description?: string;
}

/** The fields of a line that decide its net price. */
export type BillPriceEdit = Pick<BillRow, 'unitCost' | 'discountPct'>;

/** The fields of a line the price comparison reads from the billable data. */
export type BillPriceLine = Pick<BillableLineDto, 'taxRate' | 'orderNetUnitPrice'>;

/** Trimmed text, or undefined when blank. */
function text(v: string | null | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

/**
 * The net price per base unit of an invoice line, as the server compares it
 * with the order (ADR-026 §2): the unit cost less the discount, and without
 * tax when the company's prices include tax. A blank discount is zero; a
 * blank or invalid tax rate is zero too. The result is rounded to 6 decimals,
 * half up, the precision the server stores the order's net price with.
 */
export function invoiceNetUnitPrice(input: {
  unitCost: string | null | undefined;
  discountPct: string | null | undefined;
  taxRate: string | null | undefined;
  pricesIncludeTax: boolean;
}): Decimal {
  const afterDiscount = dec(input.unitCost).times(dec(100).minus(dec(input.discountPct)).div(100));
  const net = input.pricesIncludeTax ? afterDiscount.div(dec(input.taxRate).div(100).plus(1)) : afterDiscount;
  return net.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/**
 * Whether the invoice price of a line is above the order's net price. A line
 * with no order price to compare with (null) is never above it.
 */
export function isAbovePrice(line: BillPriceLine, edit: BillPriceEdit, pricesIncludeTax: boolean): boolean {
  const orderNet = toDecimal(line.orderNetUnitPrice);
  if (orderNet === null) return false;
  const net = invoiceNetUnitPrice({
    unitCost: edit.unitCost,
    discountPct: edit.discountPct,
    taxRate: line.taxRate,
    pricesIncludeTax,
  });
  return net.gt(orderNet);
}

/**
 * One row per receipt line that still has something to bill, pre-filled with
 * the server's suggested price (the order's, on the company's tax basis).
 * Lines fully billed already are left out.
 */
export function defaultBillRows(billable: Pick<PurchaseOrderBillableDto, 'lines'>): BillRow[] {
  return billable.lines
    .filter((l) => dec(l.unbilledQty).gt(0))
    .map((l) => ({
      grnLineId: l.grnLineId,
      selected: true,
      qty: l.unbilledQty,
      unitCost: l.defaultUnitCost,
      discountPct: l.defaultDiscountPct,
    }));
}

/**
 * A row goes into the invoice when it is selected and its quantity is above
 * zero. A blank quantity is not zero: it is an error (see billIssues).
 */
export function isBilledRow(row: BillRow): boolean {
  return row.selected && dec(row.qty).gt(0);
}

/** Body of POST /purchase-orders/:id/bill: the selected rows with a quantity, nothing computed. */
export function billBody(header: BillHeaderForm, rows: readonly BillRow[]): BillPurchaseOrderDto {
  const lines: BillLineDto[] = rows.filter(isBilledRow).map((r) => {
    const line: BillLineDto = { grnLineId: r.grnLineId, qty: r.qty.trim(), unitCost: r.unitCost.trim() };
    const discountPct = text(r.discountPct);
    if (discountPct) line.discountPct = discountPct;
    return line;
  });
  const body: BillPurchaseOrderDto = {
    invoiceDate: header.invoiceDate,
    paymentType: header.paymentType,
    lines,
  };
  const cashAccountId = text(header.cashAccountId);
  const supplierInvoiceNo = text(header.supplierInvoiceNo);
  const description = text(header.description);
  if (header.paymentType === 'CASH' && cashAccountId) body.cashAccountId = cashAccountId;
  if (supplierInvoiceNo) body.supplierInvoiceNo = supplierInvoiceNo;
  if (description) body.description = description;
  return body;
}

/** A reason the bill cannot be sent yet. The modal turns each into a message. */
export type BillIssueCode =
  | 'NO_LINES'
  | 'QTY_INVALID'
  | 'QTY_ABOVE_UNBILLED'
  | 'UNIT_COST_INVALID'
  | 'DISCOUNT_INVALID'
  | 'CASH_ACCOUNT_REQUIRED';

export interface BillIssue {
  code: BillIssueCode;
  /** The receipt line the issue is about; absent for header issues. */
  grnLineId?: string;
}

/** Up to `places` decimals, no sign, no exponent: "12.345" with places 3. */
function hasAtMostPlaces(v: string, places: number): boolean {
  const re = new RegExp(`^\\d+(\\.\\d{1,${places}})?$`);
  return re.test(v.trim());
}

/**
 * Everything wrong with the bill as the user has it, in the order the form
 * shows it. Quantities are checked against what is still unbilled on the
 * receipt line; a selected row with a blank or invalid quantity is an error,
 * a row whose quantity is zero is simply left out.
 */
export function billIssues(
  billable: Pick<PurchaseOrderBillableDto, 'lines'>,
  header: BillHeaderForm,
  rows: readonly BillRow[],
): BillIssue[] {
  const issues: BillIssue[] = [];
  const unbilled = new Map(billable.lines.map((l) => [l.grnLineId, l.unbilledQty]));
  const included = rows.filter(isBilledRow);

  if (included.length === 0) issues.push({ code: 'NO_LINES' });

  for (const row of rows) {
    if (!row.selected) continue;
    const qty = toDecimal(row.qty);
    if (qty === null || qty.lt(0)) {
      issues.push({ code: 'QTY_INVALID', grnLineId: row.grnLineId });
    } else if (qty.gt(0) && qty.gt(dec(unbilled.get(row.grnLineId)))) {
      issues.push({ code: 'QTY_ABOVE_UNBILLED', grnLineId: row.grnLineId });
    }
  }

  for (const row of included) {
    const unitCost = toDecimal(row.unitCost);
    if (unitCost === null || unitCost.lt(0) || !hasAtMostPlaces(row.unitCost, 6)) {
      issues.push({ code: 'UNIT_COST_INVALID', grnLineId: row.grnLineId });
    }
    const discount = text(row.discountPct);
    if (discount !== undefined) {
      const pct = toDecimal(discount);
      if (pct === null || pct.lt(0) || pct.gt(100) || !hasAtMostPlaces(discount, 4)) {
        issues.push({ code: 'DISCOUNT_INVALID', grnLineId: row.grnLineId });
      }
    }
  }

  if (header.paymentType === 'CASH' && !text(header.cashAccountId)) {
    issues.push({ code: 'CASH_ACCOUNT_REQUIRED' });
  }
  return issues;
}

/** The selected rows whose invoice price is above the order price (the ones that need approval). */
export function aboveRows(
  billable: Pick<PurchaseOrderBillableDto, 'lines' | 'pricesIncludeTax'>,
  rows: readonly BillRow[],
): BillRow[] {
  const byId = new Map(billable.lines.map((l) => [l.grnLineId, l]));
  return rows.filter((r) => {
    const line = byId.get(r.grnLineId);
    return isBilledRow(r) && !!line && isAbovePrice(line, r, billable.pricesIncludeTax);
  });
}
