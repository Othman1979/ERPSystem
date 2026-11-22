import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Rows per batch: each batch is one short transaction, so no long lock on the tables. */
export const PURGE_BATCH = 5_000;
/** At most this many batches per run; the next Cron run continues. */
const MAX_BATCHES = 200;

export interface PurgeExpiredRun {
  /** Idempotency keys past their expiry (any status) that were deleted. */
  idempotencyKeys: number;
  /** Refresh tokens past their expiry that were deleted. */
  refreshTokens: number;
  /** Document edit locks expired for more than one day that were deleted. */
  documentEditLocks: number;
  ms: number;
}

/**
 * Deletes what expiry has made useless (DB-12), run by Cron via
 * `pnpm --filter api job:purge-expired`:
 *  - idempotency keys past expires_at: a retry after that is a new request;
 *  - refresh tokens past expires_at: an expired token is refused anyway.
 * Revoked tokens are kept until they expire, because reuse detection needs
 * them. A token that another token replaced has its replaced_by_id cleared
 * before it is deleted, so no foreign key blocks the delete.
 *
 * systemPrisma: platform-wide cleanup across tenants (allowed in `jobs`).
 */
// ADR-045 29C: the purge-expired job remains on the control database.
@Injectable()
export class PurgeExpiredService {
  constructor(private readonly prisma: PrismaService) {}

  async run(now = new Date()): Promise<PurgeExpiredRun> {
    const started = Date.now();
    // systemPrisma: platform-wide cleanup across tenants (allowed in jobs)
    const db = this.prisma.client;

    const idempotencyKeys = await deleteInBatches(async () => {
      const rows = await db.idempotencyKey.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        take: PURGE_BATCH,
        orderBy: { id: 'asc' },
      });
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) await db.idempotencyKey.deleteMany({ where: { id: { in: ids } } });
      return ids.length;
    });

    const refreshTokens = await deleteInBatches(async () => {
      const rows = await db.refreshToken.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        take: PURGE_BATCH,
        orderBy: { id: 'asc' },
      });
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return 0;
      // The self relation (replacedById) must not block the delete.
      await db.refreshToken.updateMany({ where: { replacedById: { in: ids } }, data: { replacedById: null } });
      await db.refreshToken.deleteMany({ where: { id: { in: ids } } });
      return ids.length;
    });

    const documentEditLocks = await this.deleteExpiredDocumentLocks(db);
    return { idempotencyKeys, refreshTokens, documentEditLocks, ms: Date.now() - started };
  }

  private async deleteExpiredDocumentLocks(db: PrismaService['client']): Promise<number> {
    const tenants = await db.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    let total = 0;
    for (const { id: tenantId } of tenants) {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const deleted = await db.$executeRaw`
          DELETE FROM document_edit_locks
           WHERE tenant_id = ${tenantId}
             AND expires_at < DATE_SUB(NOW(3), INTERVAL 1 DAY)
           ORDER BY id
           LIMIT ${PURGE_BATCH}`;
        total += deleted;
        if (deleted < PURGE_BATCH) break;
      }
    }
    return total;
  }
}

/** Runs `step` until a batch comes back smaller than PURGE_BATCH (or the batch cap). Returns the total deleted. */
async function deleteInBatches(step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await step();
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}
