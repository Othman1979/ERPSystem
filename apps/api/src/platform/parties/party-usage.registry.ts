import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * One module's answer to "does anything you own reference this party?"
 * (DB-15, ADR-021): the name of the first table found that references it,
 * or null when none does. Runs on the caller's transaction (which holds the
 * party row lock, see PartiesService.deactivate) in the request's tenant
 * scope, and counts drafts as well as posted rows. It must read through
 * `tx` only: another client would take a second pool connection.
 */
export type PartyUsageCheck = (tx: Prisma.TransactionClient, partyId: bigint) => Promise<string | null>;

/**
 * The modules whose tables reference parties. Each registers its check on
 * start-up; a party is deleted only when every one of them has answered
 * "unused", so a module that failed to register blocks deletes instead of
 * letting them through.
 */
export const PARTY_USAGE_OWNERS = ['sales', 'purchases', 'treasury', 'journal'] as const;
export type PartyUsageOwner = (typeof PARTY_USAGE_OWNERS)[number];

/**
 * Collects the "party in use" checks of the owning modules (ADR-021).
 * A registry rather than direct injection: journal and treasury already
 * import the parties module, so the parties module can't import them back.
 */
@Injectable()
export class PartyUsageRegistry {
  private readonly checks = new Map<PartyUsageOwner, PartyUsageCheck>();

  register(owner: PartyUsageOwner, check: PartyUsageCheck): void {
    this.checks.set(owner, check);
  }

  /**
   * Where the party is referenced, as `owner:table`; empty when nowhere.
   * The checks run one after another: they share one transaction connection.
   */
  async usage(tx: Prisma.TransactionClient, partyId: bigint): Promise<string[]> {
    const missing = PARTY_USAGE_OWNERS.filter((o) => !this.checks.has(o));
    if (missing.length > 0) {
      throw new DomainError(ErrorCode.INTERNAL, `Party usage check not registered: ${missing.join(', ')}`);
    }
    const found: string[] = [];
    for (const owner of PARTY_USAGE_OWNERS) {
      const table = await this.checks.get(owner)!(tx, partyId);
      if (table !== null) found.push(`${owner}:${table}`);
    }
    return found;
  }
}
