import type { SalesLineDto } from '@erp/api-client';
import { dec } from '../../format/number';

/** A line of a sales quote or order form; numeric fields are decimal strings. */
export interface SalesFormLine {
  itemId?: string;
  itemUnitId?: string;
  qty?: string | null;
  unitPrice?: string | null;
  discountPct?: string | null;
}

/** Trimmed text, or undefined when blank. */
function text(v: string | null | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

/**
 * Indexes of the lines that have an item and a quantity but no unit price.
 * A blank price is never sent as zero; a price of '0' is a price.
 */
export function missingSalesPriceLines(lines: readonly SalesFormLine[]): number[] {
  return lines.flatMap((l, index) => (l.itemId && text(l.qty) && !text(l.unitPrice) ? [index] : []));
}

/**
 * Lines as the API takes them. A line without an item or a quantity is not
 * sent. The server computes every net, tax and total; none is sent from here.
 * The screen blocks a save while `missingSalesPriceLines` is not empty, so a
 * line with a quantity and no price reaching here is a caller error.
 */
export function salesLineBodies(lines: readonly SalesFormLine[]): SalesLineDto[] {
  return lines.flatMap((l): SalesLineDto[] => {
    const qty = text(l.qty);
    if (!l.itemId || !qty) return [];
    const unitPrice = text(l.unitPrice);
    if (!unitPrice) throw new Error('a unit price is required on every line with an item');
    const line: SalesLineDto = { itemId: l.itemId, qty, unitPrice };
    const itemUnitId = text(l.itemUnitId);
    const discountPct = text(l.discountPct);
    if (itemUnitId) line.itemUnitId = itemUnitId;
    if (discountPct) line.discountPct = discountPct;
    return [line];
  });
}

/**
 * The items whose quantity on the lines is above what is available after the
 * other orders' reservations. A product on several lines is compared as one
 * total, as the server reserves it. Items without an available figure are skipped.
 */
export function reservationShortfalls(
  lines: readonly { itemId: string; qtyBase: string }[],
  items: readonly { itemId: string; available: string | null }[],
): Set<string> {
  const wanted = new Map<string, ReturnType<typeof dec>>();
  for (const l of lines) wanted.set(l.itemId, (wanted.get(l.itemId) ?? dec(0)).plus(dec(l.qtyBase)));
  const short = new Set<string>();
  for (const row of items) {
    const need = wanted.get(row.itemId);
    if (need && row.available !== null && need.gt(dec(row.available))) short.add(row.itemId);
  }
  return short;
}

/**
 * The order line ids whose invoice line is priced below the order: a unit
 * price under the order's, or a discount above it (ADR-027 §4).
 */
export function linesBelowOrder(
  invoiceLines: readonly { orderLineId: string | null; unitPrice: string; discountPct: string }[],
  orderLines: readonly { id: string; unitPrice: string; discountPct: string }[],
): Set<string> {
  const byId = new Map(orderLines.map((l) => [l.id, l]));
  const below = new Set<string>();
  for (const line of invoiceLines) {
    const orderLine = line.orderLineId ? byId.get(line.orderLineId) : undefined;
    if (!orderLine) continue;
    if (dec(line.unitPrice).lt(dec(orderLine.unitPrice)) || dec(line.discountPct).gt(dec(orderLine.discountPct))) {
      below.add(orderLine.id);
    }
  }
  return below;
}
