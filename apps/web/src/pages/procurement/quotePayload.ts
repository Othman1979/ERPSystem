import type {
  ConvertPurchaseRequestDto,
  ConvertSelectionDto,
  PurchaseComparisonDto,
  ReceivePurchaseQuoteDto,
  UpdatePurchaseQuoteDto,
} from '@erp/api-client';
import { dec } from '../../format/number';

/** The chosen offer per request line: request line id to the quote line id that wins it. */
export type QuotePicks = Readonly<Record<string, string>>;

/** One price typed for a quote line; every value is a decimal string. */
export interface ReceiveLineInput {
  lineId: string;
  unitPrice: string;
  discountPct?: string | null;
}

/**
 * Body of POST /purchase-quotes/:id/receive. Blank optional fields are left
 * out, so the server keeps its defaults. The server computes every total.
 */
export function receiveBody(
  lines: readonly ReceiveLineInput[],
  supplierRef?: string | null,
  validUntil?: string | null,
): ReceivePurchaseQuoteDto {
  const ref = supplierRef?.trim();
  return {
    ...(ref ? { supplierRef: ref } : {}),
    ...(validUntil ? { validUntil } : {}),
    lines: lines.map((l) => {
      const discount = l.discountPct?.trim();
      return {
        lineId: l.lineId,
        unitPrice: l.unitPrice.trim(),
        ...(discount ? { discountPct: discount } : {}),
      };
    }),
  };
}

/** Header fields of the order(s) created from a request. Dates are 'YYYY-MM-DD'. */
export interface ConvertHeader {
  orderDate: string;
  expectedDate?: string | null;
  warehouseId: string;
  costCenterId?: string | null;
  notes?: string | null;
}

/**
 * Body of POST /purchase-requests/:id/convert. One selection per request line
 * that has a pick. No quantity is sent: the server takes the offer's quantity,
 * capped at what the request still needs, and groups the lines into one draft
 * order per supplier.
 */
export function convertBody(header: ConvertHeader, picks: QuotePicks): ConvertPurchaseRequestDto {
  const notes = header.notes?.trim();
  const expectedDate = header.expectedDate;
  return {
    orderDate: header.orderDate,
    ...(expectedDate ? { expectedDate } : {}),
    warehouseId: header.warehouseId,
    ...(header.costCenterId ? { costCenterId: header.costCenterId } : {}),
    ...(notes ? { notes } : {}),
    selections: Object.values(picks)
      .filter((quoteLineId) => quoteLineId !== '')
      .map((quoteLineId): ConvertSelectionDto => ({ quoteLineId })),
  };
}

/**
 * The offer that wins each request line by default: the one the server marks
 * `lowest` (the first, when several tie). Lines with nothing left to order,
 * and lines without a lowest offer, get no pick.
 */
export function defaultPicks(comparison: PurchaseComparisonDto): QuotePicks {
  const picks: Record<string, string> = {};
  for (const line of comparison.lines) {
    if (!dec(line.remainingQty).gt(0)) continue;
    const lowest = line.offers.find((offer) => offer.lowest);
    if (lowest) picks[line.requestLineId] = lowest.quoteLineId;
  }
  return picks;
}

/** A quote line as the form holds it: a request line and the quantity quoted for it. */
export interface QuoteFormLine {
  requestLineId: string;
  qty: string;
}

/** The quote form's fields, as the user left them. Dates are 'YYYY-MM-DD'. */
export interface QuoteForm {
  supplierId: string;
  quoteDate: string;
  validUntil?: string | null;
  notes?: string | null;
  lines: readonly QuoteFormLine[];
}

/**
 * Body of POST and PUT purchase quotes (the create body adds requestId).
 * Lines with no quantity are dropped; totals and tax are the server's.
 */
export function quoteBody(form: QuoteForm): UpdatePurchaseQuoteDto {
  const notes = form.notes?.trim();
  return {
    supplierId: form.supplierId,
    quoteDate: form.quoteDate,
    ...(form.validUntil ? { validUntil: form.validUntil } : {}),
    ...(notes ? { notes } : {}),
    lines: form.lines
      .filter((l) => dec(l.qty).gt(0))
      .map((l) => ({ requestLineId: l.requestLineId, qty: l.qty.trim() })),
  };
}

/**
 * The lines whose unit price is blank or not above zero. A receive needs a
 * price on every line (ADR-025 §10), so the screen blocks the call while any
 * line is listed here: a blank or zero price is never sent silently.
 */
export function missingReceivePrices(
  lines: readonly { lineId: string; unitPrice?: string | null }[],
): string[] {
  return lines.filter((l) => !dec((l.unitPrice ?? '').trim()).gt(0)).map((l) => l.lineId);
}

/**
 * The picks after the user chooses `quoteLineId` for a request line. An empty
 * choice takes the line out, so it is left out of the order's selections.
 */
export function withPick(picks: QuotePicks, requestLineId: string, quoteLineId: string): QuotePicks {
  const next: Record<string, string> = { ...picks };
  if (quoteLineId) next[requestLineId] = quoteLineId;
  else delete next[requestLineId];
  return next;
}
