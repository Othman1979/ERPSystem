import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * One module's answer to "does anything you own reference this cost centre?"
 * (ADR-024 §1.7, the ADR-021 pattern): the first table found, or null. Runs on
 * the caller's transaction, which holds the centre's row lock, and counts
 * drafts as well as posted rows. It must read through `tx` only.
 */
export type CostCenterUsageCheck = (tx: Prisma.TransactionClient, costCenterId: bigint) => Promise<string | null>;

/**
 * The modules whose tables reference cost centres. A centre is deleted, or
 * becomes a group, only when every one of them has answered "unused"; a module
 * that failed to register blocks it instead of letting it through.
 */
export const COST_CENTER_USAGE_OWNERS = ['journal', 'sales', 'purchases', 'treasury'] as const;
export type CostCenterUsageOwner = (typeof COST_CENTER_USAGE_OWNERS)[number];

/**
 * Collects the "cost centre in use" checks of the owning modules. A registry,
 * as for parties: the journal and document modules import the cost-centre
 * module (posting validates centres), so it cannot import them back.
 */
@Injectable()
export class CostCenterUsageRegistry {
  private readonly checks = new Map<CostCenterUsageOwner, CostCenterUsageCheck>();

  register(owner: CostCenterUsageOwner, check: CostCenterUsageCheck): void {
    this.checks.set(owner, check);
  }

  /** Where the centre is referenced, as `owner:table`; empty when nowhere. One after another: one connection. */
  async usage(tx: Prisma.TransactionClient, costCenterId: bigint): Promise<string[]> {
    const missing = COST_CENTER_USAGE_OWNERS.filter((o) => !this.checks.has(o));
    if (missing.length > 0) {
      throw new DomainError(ErrorCode.INTERNAL, `Cost centre usage check not registered: ${missing.join(', ')}`);
    }
    const found: string[] = [];
    for (const owner of COST_CENTER_USAGE_OWNERS) {
      const table = await this.checks.get(owner)!(tx, costCenterId);
      if (table !== null) found.push(`${owner}:${table}`);
    }
    return found;
  }
}
