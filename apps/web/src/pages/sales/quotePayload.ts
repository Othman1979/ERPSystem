import dayjs from 'dayjs';
import type { ConvertSalesQuoteDto, CreateSalesQuoteDto } from '@erp/api-client';
import { salesLineBodies, type SalesFormLine } from './salesLines';

/** The quote form's fields as the user left them. Dates are 'YYYY-MM-DD'. */
export interface SalesQuoteForm {
  customerId: string;
  /** Optional: when the quote is converted without one, the screen asks for the order's warehouse. */
  warehouseId?: string;
  costCenterId?: string;
  quoteDate: string;
  validUntil?: string;
  description?: string;
  lines: readonly SalesFormLine[];
}

/**
 * The default expiry of a new quote: the quote date plus the company's validity
 * in days (ADR-027 §1). Zero days means no default expiry.
 */
export function defaultValidUntil(quoteDate: string, validityDays: number): string | undefined {
  if (!(validityDays > 0)) return undefined;
  return dayjs(quoteDate).add(validityDays, 'day').format('YYYY-MM-DD');
}

/**
 * Whether a quote is expired: it was sent and its validity date is before
 * today (ADR-027 §2). Compares 'YYYY-MM-DD' strings, which order as dates.
 */
export function isQuoteExpired(status: string, validUntil: string | null | undefined, today: string): boolean {
  return status === 'SENT' && !!validUntil && validUntil < today;
}

/**
 * Body of POST and PUT sales quotes. An empty validity is sent as null, so an
 * edit can clear it. Totals and tax are the server's.
 */
export function salesQuoteBody(form: SalesQuoteForm): CreateSalesQuoteDto {
  const description = form.description?.trim();
  return {
    quoteDate: form.quoteDate,
    validUntil: form.validUntil ?? null,
    customerId: form.customerId,
    ...(form.warehouseId ? { warehouseId: form.warehouseId } : {}),
    ...(form.costCenterId ? { costCenterId: form.costCenterId } : {}),
    ...(description ? { description } : {}),
    lines: salesLineBodies(form.lines),
  };
}

/** Body of POST /sales-quotes/:id/convert: the warehouse only when the user gave one. */
export function convertQuoteBody(warehouseId?: string): ConvertSalesQuoteDto {
  return warehouseId ? { warehouseId } : {};
}
