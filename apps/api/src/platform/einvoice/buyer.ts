import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { BuyerScheme } from './ubl-render.js';

/** The customer fields the e-invoice buyer comes from (0005 §5). */
export interface BuyerSource {
  nameAr: string;
  taxNumber: string | null;
  nationalId: string | null;
  nationalIdKind: 'NIN' | 'PN';
  phone: string | null;
  isCashCustomer: boolean;
}

export interface EInvoiceBuyer {
  scheme: BuyerScheme;
  id: string;
  name?: string;
  phone?: string;
}

/** Above this, a cash invoice needs a named buyer too (manual p.14). */
export const NAMED_BUYER_LIMIT = new Decimal('10000');

const clean = (s: string | null) => (s ?? '').replace(/[\s-]/g, '');

/**
 * Who the buyer is on the e-invoice (0005 §5, owner decision §11.2):
 *  - a tax number → TN; else a national number → NIN, or PN for a non-Jordanian;
 *  - a receivable invoice, or a cash invoice above 10,000 JOD, must have one;
 *  - otherwise a walk-in buyer, TN 0 (a common convention; the manual defines none).
 * Ids are digits only (p.14).
 */
export function resolveBuyer(
  src: BuyerSource,
  paymentType: 'CASH' | 'CREDIT',
  grandTotal: Decimal.Value,
): { ok: true; buyer: EInvoiceBuyer } | { ok: false; reason: string } {
  const taxNumber = clean(src.taxNumber);
  const nationalId = clean(src.nationalId);
  for (const [label, v] of [
    ['tax number', taxNumber],
    ['national / personal number', nationalId],
  ] as const) {
    if (v && !/^\d+$/.test(v)) {
      return { ok: false, reason: `The customer's ${label} must contain digits only` };
    }
  }
  const phone = src.phone?.trim() || undefined;
  if (taxNumber) return { ok: true, buyer: { scheme: 'TN', id: taxNumber, name: src.nameAr, phone } };
  if (nationalId) return { ok: true, buyer: { scheme: src.nationalIdKind, id: nationalId, name: src.nameAr, phone } };
  if (paymentType === 'CREDIT' || new Decimal(grandTotal).gt(NAMED_BUYER_LIMIT)) {
    return {
      ok: false,
      reason:
        'A credit invoice, or a cash invoice above 10,000 JOD, needs the customer’s tax number or national / personal number',
    };
  }
  return { ok: true, buyer: { scheme: 'TN', id: '0', name: src.isCashCustomer ? undefined : src.nameAr } };
}
