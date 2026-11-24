import { describe, expect, it } from 'vitest';
import type { ConsignmentOpenSaleResponseDto } from '@erp/api-client';
import { consignmentSettlementBody, updateConsignmentSelection } from './consignmentPayload';

describe('consignmentSettlementBody', () => {
  it('creates a credit settlement with linked sale ids and decimal strings', () => {
    const body = consignmentSettlementBody({
      invoiceDate: '2026-11-24',
      supplierInvoiceNo: 'SUP-42',
      supplierInvoiceDate: '2026-11-23',
      description: 'November consignment',
      lines: [{
        sale: {
          id: 'sale-1', tenantId: 'tenant-1', companyId: 'company-1', warehouseId: 'warehouse-1',
          supplierId: 'supplier-1', supplier: { id: 'supplier-1', nameAr: 'مورد', nameEn: 'Supplier' },
          itemId: 'item-1', sourceType: 'SALES_INVOICE', sourceId: 'invoice-1',
          sourceLineId: 'line-1', saleDate: '2026-11-20', qty: '3.000000',
          returnedQty: '0', invoicedQty: '0',
          createdAt: '2026-11-20T00:00:00.000Z', openQty: '3.000000',
          sourceNo: 'INV-42',
          item: { id: 'item-1', code: 'A', nameAr: 'صنف', nameEn: 'Item' },
        },
        qty: '1.000000',
        unitPrice: '3.333333',
      }],
    });

    expect(body).toMatchObject({
      invoiceDate: '2026-11-24',
      supplierId: 'supplier-1',
      warehouseId: 'warehouse-1',
      paymentType: 'CREDIT',
      consignmentSettlement: true,
      lines: [{ itemId: 'item-1', consignmentSaleId: 'sale-1', qty: '1.000000', unitPrice: '3.333333' }],
    });
  });
});

describe('updateConsignmentSelection', () => {
  it('selects and clears the current page while preserving edits and other pages', () => {
    const openSale = (id: string, openQty: string): ConsignmentOpenSaleResponseDto => ({
      id,
      tenantId: 'tenant-1',
      companyId: 'company-1',
      warehouseId: 'warehouse-1',
      supplierId: 'supplier-1',
      supplier: { id: 'supplier-1', nameAr: 'مورد', nameEn: 'Supplier' },
      itemId: 'item-1',
      sourceType: 'SALES_INVOICE',
      sourceId: 'invoice-1',
      sourceLineId: 'line-1',
      saleDate: '2026-11-20',
      qty: openQty,
      returnedQty: '0',
      invoicedQty: '0',
      createdAt: '2026-11-20T00:00:00.000Z',
      openQty,
      sourceNo: 'INV-42',
      item: { id: 'item-1', code: 'A', nameAr: 'صنف', nameEn: 'Item' },
    });
    const page = [openSale('sale-1', '3.000000'), openSale('sale-2', '2.000000')];
    const otherPageSale = openSale('sale-3', '4.000000');
    const current = {
      'sale-1': { sale: page[0]!, qty: '1.000000', unitPrice: '5.000' },
      'sale-3': { sale: otherPageSale, qty: '4.000000', unitPrice: '7.000' },
    };

    const selected = updateConsignmentSelection(current, page, true);
    expect(selected['sale-1']).toEqual(current['sale-1']);
    expect(selected['sale-2']).toEqual({ sale: page[1], qty: '2.000000', unitPrice: '' });
    expect(selected['sale-3']).toEqual(current['sale-3']);

    const cleared = updateConsignmentSelection(selected, page, false);
    expect(cleared).toEqual({ 'sale-3': current['sale-3'] });
  });
});
