import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ProcurementLevel } from '../../generated/prisma/enums.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/** The levels from the smallest cycle to the largest (ADR-013 §1). */
export const PROCUREMENT_LEVELS: readonly ProcurementLevel[] = [
  ProcurementLevel.SIMPLE,
  ProcurementLevel.MEDIUM,
  ProcurementLevel.FULL,
];

/** True when going from `from` to `to` drops part of the cycle. */
export function isLoweringLevel(from: ProcurementLevel, to: ProcurementLevel): boolean {
  return PROCUREMENT_LEVELS.indexOf(to) < PROCUREMENT_LEVELS.indexOf(from);
}

/**
 * Counts one kind of open purchasing-cycle document (a purchase request,
 * order or issue request not yet closed) of the current tenant. Phases 12 and
 * 13 register one per document type; existing purchase invoices and goods
 * notes are not cycle documents (ADR-024 §2.2).
 */
export interface OpenCycleDocumentsCounter {
  /** Name of the documents counted, for the refusal details (for example `purchaseOrders`). */
  readonly key: string;
  /**
   * Open documents of the tenant, read inside the level change transaction
   * (tenant-scoped client), after the company row is locked.
   */
  count(tx: Prisma.TransactionClient): Promise<number>;
}

/**
 * The registry of open cycle document counters, and the rule for changing
 * the level (ADR-024 §2.2): raising is always allowed; lowering is refused
 * with PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS while any counter reports more
 * than 0. It ships empty in phase 11 (no cycle documents yet).
 *
 * The caller holds the company row lock (SELECT … FOR UPDATE) for the check
 * and the update, so a document created from phase 12 on must read the level
 * under a shared lock of the same row to be ordered with a lowering.
 */
@Injectable()
export class ProcurementCycleRegistry {
  private readonly counters: OpenCycleDocumentsCounter[] = [];

  register(counter: OpenCycleDocumentsCounter): void {
    if (this.counters.some((c) => c.key === counter.key)) {
      throw new Error(`Open cycle documents counter "${counter.key}" is registered twice`);
    }
    this.counters.push(counter);
  }

  /** Keys of the registered counters, in registration order. */
  keys(): string[] {
    return this.counters.map((c) => c.key);
  }

  /** Refuses a lowering while documents of the cycle are open; anything else passes. */
  async assertLevelChange(tx: Prisma.TransactionClient, from: ProcurementLevel, to: ProcurementLevel): Promise<void> {
    if (!isLoweringLevel(from, to)) return;
    const open: Record<string, number> = {};
    for (const counter of this.counters) {
      const n = await counter.count(tx);
      if (n > 0) open[counter.key] = n;
    }
    if (Object.keys(open).length > 0) {
      throw new DomainError(
        ErrorCode.PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS,
        `The procurement level cannot go from ${from} to ${to} while cycle documents are open`,
        { from, to, openDocuments: open },
      );
    }
  }
}
