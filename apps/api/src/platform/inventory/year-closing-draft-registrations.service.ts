import { Injectable, type OnModuleInit } from '@nestjs/common';
import { YearClosingDraftRegistry, yearClosingDraft } from '../accounting/year-closing-draft.registry.js';

@Injectable()
export class InventoryYearClosingDraftRegistrations implements OnModuleInit {
  constructor(private readonly drafts: YearClosingDraftRegistry) {}

  onModuleInit(): void {
    this.drafts.register('STOCK_ADJUSTMENT', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.stockAdjustment.findMany({
        where: { tenantId, companyId, status: 'DRAFT', adjustmentDate: { gte: from, lte: to } },
        select: { id: true, adjustmentDate: true, docNo: true },
      });
      return rows.map((row) => yearClosingDraft('STOCK_ADJUSTMENT', row.id, row.adjustmentDate, row.docNo));
    });
    this.drafts.register('STOCK_TRANSFER', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.stockTransfer.findMany({
        where: { tenantId, companyId, status: 'DRAFT', transferDate: { gte: from, lte: to } },
        select: { id: true, transferDate: true, docNo: true },
      });
      return rows.map((row) => yearClosingDraft('STOCK_TRANSFER', row.id, row.transferDate, row.docNo));
    });
    this.drafts.register('STOCK_COUNT', async (tx, tenantId, companyId, from, to) => {
      const rows = await tx.stockCount.findMany({
        where: { tenantId, companyId, status: 'DRAFT', countDate: { gte: from, lte: to } },
        select: { id: true, countDate: true, docNo: true },
      });
      return rows.map((row) => yearClosingDraft('STOCK_COUNT', row.id, row.countDate, row.docNo));
    });
  }
}
