import { Decimal, round6, sum } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { CatalogLineRefs } from '../inventory/catalog.service.js';
import { computeLineAmounts, type ComputedLineAmounts } from '../shared/invoice-math.js';

/** An item and quantity as a line names them (before prices). */
export interface LineItemInput {
  itemId: string;
  itemUnitId?: string | null;
  qty: string;
}

/** A line's item resolved against the catalog. */
export interface ResolvedItem {
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  qty: Decimal;
  qtyBase: Decimal;
  /** The item's tax category, else the company default (ADR-025 §11: tax from the item). */
  taxCategoryId: bigint | null;
  taxRate: Decimal;
}

/**
 * Resolves a line's item, unit and tax against the catalog refs: the item is
 * the company's and active, the unit belongs to it, the quantity is above 0.
 * The tax category is the item's, falling back to the default one, as on
 * purchase invoices; never from the client (ADR-025 §11).
 */
export function resolveItem(refs: CatalogLineRefs, line: LineItemInput): ResolvedItem {
  const itemId = BigInt(line.itemId);
  const item = refs.items.get(itemId);
  if (!item) throw DomainError.notFound('Item', line.itemId);
  let itemUnitId: bigint | null = null;
  let factorToBase = new Decimal(1);
  if (line.itemUnitId) {
    const unit = refs.units.get(BigInt(line.itemUnitId));
    if (!unit || unit.itemId !== itemId) {
      throw new DomainError(ErrorCode.VALIDATION, `Item unit ${line.itemUnitId} does not belong to item ${item.code}`);
    }
    itemUnitId = unit.id;
    factorToBase = unit.factorToBase;
  }
  const qty = new Decimal(line.qty);
  if (qty.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
  const tax = item.taxCategory ?? refs.defaultTax;
  return {
    itemId,
    itemUnitId,
    factorToBase,
    qty,
    qtyBase: round6(qty.times(factorToBase)),
    taxCategoryId: tax?.id ?? null,
    taxRate: tax?.rate ?? new Decimal(0),
  };
}

/** A priced line: the item plus its amounts, computed here (ADR-017), never taken from the client. */
export interface PricedLine extends ResolvedItem {
  unitPrice: Decimal;
  discountPct: Decimal;
  amounts: ComputedLineAmounts;
}

export function priceLine(item: ResolvedItem, unitPrice: string, discountPct: string | undefined, pricesIncludeTax: boolean): PricedLine {
  const amounts = computeLineAmounts({
    qty: item.qty,
    factorToBase: item.factorToBase,
    unitPrice,
    discountPct: discountPct ?? '0',
    taxRate: item.taxRate,
    pricesIncludeTax,
  });
  return { ...item, unitPrice: new Decimal(unitPrice), discountPct: new Decimal(discountPct ?? '0'), amounts };
}

/** Header totals: the sums of the lines' amounts. */
export function documentTotals(lines: { amounts: ComputedLineAmounts }[]): {
  netTotal: Decimal;
  taxTotal: Decimal;
  grandTotal: Decimal;
} {
  return {
    netTotal: sum(lines.map((l) => l.amounts.netAmount)),
    taxTotal: sum(lines.map((l) => l.amounts.taxAmount)),
    grandTotal: sum(lines.map((l) => l.amounts.lineTotal)),
  };
}

/** The line's amount columns as stored. */
export function amountColumns(l: PricedLine) {
  return {
    qty: l.qty,
    qtyBase: l.amounts.qtyBase,
    unitPrice: l.unitPrice,
    discountPct: l.discountPct,
    discountAmount: l.amounts.discountAmount,
    netAmount: l.amounts.netAmount,
    taxCategoryId: l.taxCategoryId,
    taxRate: l.taxRate,
    taxAmount: l.amounts.taxAmount,
    lineTotal: l.amounts.lineTotal,
  };
}

/**
 * What is left to order on a request line (ADR-025 §9): its quantity less
 * what orders that are not cancelled already hold, in the line's unit.
 */
export function remainingQty(line: { qty: { toString(): string }; orderedQty: { toString(): string } }): Decimal {
  return new Decimal(line.qty.toString()).minus(line.orderedQty.toString());
}

/**
 * Adds up quantities per request line and refuses any over what is left
 * (PURCHASE_REQUEST_QTY_EXCEEDED). `remaining` is read under the request
 * lines' locks.
 */
export function assertWithinRemaining(
  wanted: { requestLineId: bigint; qty: Decimal }[],
  remaining: Map<bigint, Decimal>,
): Map<bigint, Decimal> {
  const byLine = new Map<bigint, Decimal>();
  for (const w of wanted) byLine.set(w.requestLineId, (byLine.get(w.requestLineId) ?? new Decimal(0)).plus(w.qty));
  for (const [lineId, qty] of byLine) {
    const left = remaining.get(lineId);
    if (left === undefined) throw DomainError.notFound('PurchaseRequestLine', lineId.toString());
    if (qty.gt(left)) {
      throw new DomainError(
        ErrorCode.PURCHASE_REQUEST_QTY_EXCEEDED,
        `The quantity ordered exceeds what is left on request line ${lineId.toString()}`,
        { requestLineId: lineId.toString(), remaining: left.toFixed(6), wanted: qty.toFixed(6) },
      );
    }
  }
  return byLine;
}
