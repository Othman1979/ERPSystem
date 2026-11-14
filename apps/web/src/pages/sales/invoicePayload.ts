import type { CreateSalesInvoiceDto, SalesInvoiceDetailDto } from '@erp/api-client';

/** An editable line of the sales invoice form; numeric fields are decimal strings. */
export interface SalesInvoiceFormLine {
  itemId?: string;
  qty?: string | null;
  price?: string | null;
  discountPct?: string | null;
}

/** What the sales invoice form holds when the user saves. Dates are 'YYYY-MM-DD'. */
export interface SalesInvoiceForm {
  invoiceDate: string;
  dueDate?: string;
  customerId: string;
  warehouseId: string;
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId?: string;
  lines: SalesInvoiceFormLine[];
}

/**
 * Initial form state for a sales invoice. A new invoice starts as CREDIT;
 * an edit keeps the saved cash account, so a CASH invoice does not lose it.
 */
export function salesInvoiceFormDefaults(invoice?: SalesInvoiceDetailDto): {
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId?: string;
} {
  return {
    paymentType: invoice?.paymentType ?? 'CREDIT',
    cashAccountId: invoice?.cashAccountId ?? undefined,
  };
}

/**
 * The body of POST/PUT sales invoices. The form has no description input, so
 * the loaded invoice's description is passed through; otherwise an edit would
 * clear it.
 */
export function salesInvoiceBody(form: SalesInvoiceForm, invoice?: SalesInvoiceDetailDto): CreateSalesInvoiceDto {
  return {
    invoiceDate: form.invoiceDate,
    dueDate: form.dueDate,
    customerId: form.customerId,
    warehouseId: form.warehouseId,
    paymentType: form.paymentType,
    cashAccountId: form.paymentType === 'CASH' ? form.cashAccountId : undefined,
    description: invoice?.description ?? undefined,
    lines: form.lines.flatMap((l) =>
      l.itemId && l.qty
        ? [
            {
              itemId: l.itemId,
              qty: l.qty,
              unitPrice: l.price ?? '0',
              discountPct: l.discountPct ?? undefined,
            },
          ]
        : [],
    ),
  };
}
