import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../common/cls/cls.types.js';
import { StockLedgerService, type VerifyMismatch } from '../platform/inventory/stock-ledger.service.js';
import { ErrorEventsService } from '../platform/monitoring/error-events.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface StockVerifyRun {
  ok: boolean;
  tenants: number;
  failing: { tenantId: string; mismatches: VerifyMismatch[] }[];
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
    private readonly cls: ClsService<RequestContext>,
    private readonly ledger: StockLedgerService,
    private readonly errors: ErrorEventsService,
  ) {}

  async run(): Promise<StockVerifyRun> {
    // systemPrisma: the tenants table is platform-wide; each tenant is then
    // verified through the tenant-scoped client in its own CLS context.
    const tenants = await this.prisma.client.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    const failing: StockVerifyRun['failing'] = [];
    for (const t of tenants) {
      const result = await this.cls.run(async () => {
        this.cls.set('tenantId', t.id);
        return this.ledger.verify();
      });
      if (result.mismatches.length > 0) failing.push({ tenantId: t.id.toString(), mismatches: result.mismatches });
    }
    if (failing.length > 0) {
      await this.errors.record({
        source: 'JOB',
        path: 'stock-verify',
        error: new Error(`stock:verify found differences in ${failing.length} tenant(s): ${failing.map((f) => f.tenantId).join(', ')}`),
      });
    }
    return { ok: failing.length === 0, tenants: tenants.length, failing };
  }
}
