import { Injectable } from '@nestjs/common';
import { StockLedgerService, type VerifyMismatch } from '../platform/inventory/stock-ledger.service.js';
import { ErrorEventsService } from '../platform/monitoring/error-events.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantFanoutService } from '../prisma/tenant-fanout.js';

export interface StockVerifyRun {
  ok: boolean;
  tenants: number;
  failing: { tenantId: string; mismatches: VerifyMismatch[] }[];
  unavailable?: string[];
}

/**
 * `job:stock-verify` (TRADE-20 / DB-11), a daily Cron command: runs
 * stock:verify — quantities, item_costs value, and stock value against the
 * GL inventory account — for every tenant with stock movements, each in its
 * own tenant context. A difference fails the command (Cron mail) and is
 * recorded as a JOB error, so the hourly error digest alerts it (ADR-010
 * §10.3). Mismatch lists hold ids and amounts only.
 */
@Injectable()
export class StockVerifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fanout: TenantFanoutService,
    private readonly ledger: StockLedgerService,
    private readonly errors: ErrorEventsService,
  ) {}

  async run(): Promise<StockVerifyRun> {
    const failing: StockVerifyRun['failing'] = [];
    const { results, unavailable } = await this.fanout.forEachTenant(async () => this.ledger.verify());
    for (const { tenantId, result } of results) {
      if (result.mismatches.length > 0) failing.push({ tenantId: tenantId.toString(), mismatches: result.mismatches });
    }
    if (failing.length > 0 || unavailable.length > 0) {
      const detail =
        this.prisma.tenancyMode === 'shared'
          ? `stock:verify found differences in ${failing.length} tenant(s): ${failing.map((f) => f.tenantId).join(', ')}`
          : `stock:verify found differences in ${failing.length} tenant(s) and unavailable databases: ${unavailable.join(', ')}`;
      await this.errors.record({
        source: 'JOB',
        path: 'stock-verify',
        error: new Error(detail),
      });
    }
    return {
      ok: failing.length === 0 && unavailable.length === 0,
      tenants: results.length + unavailable.length,
      failing,
      ...(this.prisma.tenancyMode === 'isolated' ? { unavailable: unavailable.map(String) } : {}),
    };
  }
}
