import { describe, expect, it } from 'vitest';
import { consignmentSettlementBody } from './consignmentPayload';

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
          supplierId: 'supplier-1', itemId: 'item-1', sourceType: 'SALES_INVOICE', sourceId: 'invoice-1',
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
