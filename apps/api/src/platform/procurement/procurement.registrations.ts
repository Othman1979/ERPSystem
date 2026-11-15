import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProcurementCycleRegistry } from '../../common/procurement/procurement-level.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CostCenterUsageRegistry } from '../cost-centers/cost-center-usage.registry.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchaseQuotesService } from './purchase-quotes.service.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';

/**
 * What the procurement module tells the registries on start-up:
 *  - the open-documents counters of the level change (ADR-025 §6, ADR-024 §2.2);
 *  - suppliers on quotes and orders are «in use» (ADR-021, ADR-025 §15);
 *  - cost centres on order headers are «in use» (ADR-024 §1.7).
 * Each check reads through the caller's transaction only.
 */
@Injectable()
export class ProcurementRegistrations implements OnModuleInit {
  constructor(
    private readonly cycle: ProcurementCycleRegistry,
    private readonly partyUsage: PartyUsageRegistry,
    private readonly costCenterUsage: CostCenterUsageRegistry,
    private readonly requests: PurchaseRequestsService,
    private readonly quotes: PurchaseQuotesService,
    private readonly orders: PurchaseOrdersService,
  ) {}

  onModuleInit(): void {
    // ADR-025 §6 (owner decision on #47): requests and quotes belong to FULL,
    // orders to MEDIUM, so only a lowering below that level counts them.
    this.cycle.register({ key: 'purchaseRequests', level: 'FULL', count: (tx) => this.requests.countOpen(tx) });
    this.cycle.register({ key: 'purchaseQuotes', level: 'FULL', count: (tx) => this.quotes.countOpen(tx) });
    this.cycle.register({ key: 'purchaseOrders', level: 'MEDIUM', count: (tx) => this.orders.countOpen(tx) });
    this.partyUsage.register('procurement', (tx, partyId) => this.partyInUse(tx, partyId));
    this.costCenterUsage.register('procurement', async (tx, id) =>
      (await tx.purchaseOrder.findFirst({ where: { costCenterId: id }, select: { id: true } })) ? 'purchase_orders' : null,
    );
  }

  /** The first procurement table naming the supplier, in any status, or null. */
  async partyInUse(tx: Prisma.TransactionClient, partyId: bigint): Promise<string | null> {
    if (await tx.purchaseQuote.findFirst({ where: { supplierId: partyId }, select: { id: true } })) return 'purchase_quotes';
    if (await tx.purchaseOrder.findFirst({ where: { supplierId: partyId }, select: { id: true } })) return 'purchase_orders';
    return null;
  }
}
