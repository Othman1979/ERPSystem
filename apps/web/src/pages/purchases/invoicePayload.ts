import type { CreatePurchaseInvoiceDto, PurchaseInvoiceDetailDto } from '@erp/api-client';
import dayjs from 'dayjs';

/** An editable line of the purchase invoice form; numeric fields are decimal strings. */
export interface PurchaseInvoiceFormLine {
  itemId?: string;
  qty?: string | null;
  price?: string | null;
  discountPct?: string | null;
}

/** What the purchase invoice form holds when the user saves. Dates are 'YYYY-MM-DD'. */
export interface PurchaseInvoiceForm {
  invoiceDate: string;
  dueDate?: string;
  supplierId: string;
  supplierInvoiceNo?: string;
  supplierInvoiceDate?: string;
  warehouseId?: string;
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId?: string;
  lines: PurchaseInvoiceFormLine[];
}

/**
 * Initial form state for a purchase invoice. A new invoice starts as CREDIT
 * with nothing filled in; an edit starts from the saved invoice, so the
 * supplier invoice fields and the cash account are not lost on save.
 */
export function purchaseInvoiceFormDefaults(invoice?: PurchaseInvoiceDetailDto): {
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId?: string;
  supplierInvoiceNo?: string;
  supplierInvoiceDate?: string;
} {
  return {
    paymentType: invoice?.paymentType ?? 'CREDIT',
    cashAccountId: invoice?.cashAccountId ?? undefined,
    supplierInvoiceNo: invoice?.supplierInvoiceNo ?? undefined,
    supplierInvoiceDate: invoice?.supplierInvoiceDate
      ? dayjs(invoice.supplierInvoiceDate).format('YYYY-MM-DD')
      : undefined,
  };
}

/**
 * The body of POST/PUT purchase invoices. The API overwrites the fields it
 * receives as absent, so fields the form has no input for (description,
 * receivedGrnId) are passed through from the loaded invoice.
 */
export function purchaseInvoiceBody(
  form: PurchaseInvoiceForm,
  invoice?: PurchaseInvoiceDetailDto,
): CreatePurchaseInvoiceDto {
  return {
    invoiceDate: form.invoiceDate,
    dueDate: form.dueDate,
    supplierId: form.supplierId,
    supplierInvoiceNo: form.supplierInvoiceNo?.trim() || undefined,
    supplierInvoiceDate: form.supplierInvoiceDate,
    warehouseId: form.warehouseId,
    paymentType: form.paymentType,
    cashAccountId: form.paymentType === 'CASH' ? form.cashAccountId : undefined,
    description: invoice?.description ?? undefined,
    receivedGrnId: invoice?.receivedGrnId ?? undefined,
    lines: form.lines.flatMap((l) =>
      l.itemId && l.qty
        ? [
            {
              itemId: l.itemId,
              qty: l.qty,
              unitCost: l.price ?? '0',
              discountPct: l.discountPct ?? undefined,
            },
          ]
        : [],
    ),
  };
}
