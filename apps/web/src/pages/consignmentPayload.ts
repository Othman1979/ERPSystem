import type { ConsignmentOpenSaleResponseDto, CreatePurchaseInvoiceDto } from '@erp/api-client';

export interface SettlementSelection {
  sale: ConsignmentOpenSaleResponseDto;
  qty: string;
  unitPrice: string;
}

export type ConsignmentSalesSelection = Record<string, SettlementSelection>;

export function updateConsignmentSelection(
  current: ConsignmentSalesSelection,
  sales: ConsignmentOpenSaleResponseDto[],
  selected: boolean,
): ConsignmentSalesSelection {
  const next = { ...current };
  for (const sale of sales) {
    if (selected) {
      next[sale.id] = current[sale.id] ?? { sale, qty: sale.openQty, unitPrice: '' };
    } else {
      delete next[sale.id];
    }
  }
  return next;
}

export function consignmentSettlementBody(input: {
  invoiceDate: string;
  supplierInvoiceNo?: string;
  supplierInvoiceDate?: string;
  description?: string;
  lines: SettlementSelection[];
}): CreatePurchaseInvoiceDto {
  const first = input.lines[0]?.sale;
  if (!first || input.lines.some(({ sale }) => sale.supplierId !== first.supplierId || sale.warehouseId !== first.warehouseId)) {
    throw new Error('A consignment settlement must have one supplier and warehouse');
  }
  return {
    invoiceDate: input.invoiceDate,
    supplierId: first.supplierId,
    warehouseId: first.warehouseId,
    paymentType: 'CREDIT',
    consignmentSettlement: true,
    supplierInvoiceNo: input.supplierInvoiceNo || undefined,
    supplierInvoiceDate: input.supplierInvoiceDate || undefined,
    description: input.description || undefined,
    lines: input.lines.map(({ sale, qty, unitPrice }) => ({
      itemId: sale.itemId,
      consignmentSaleId: sale.id,
      qty,
      unitPrice,
    })),
  };
}
