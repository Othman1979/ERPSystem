import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import type { Env } from '../../common/config/env.validation.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { TenantFanoutService } from '../../prisma/tenant-fanout.js';
import { retryWrite } from './einvoice-retry.js';
import { EInvoiceSenderService, MAX_AUTO_ATTEMPTS } from './einvoice-sender.service.js';

/** Rows taken per run. */
const BATCH = 20;
/** A row still SENDING after this was cut off mid-send: its answer is unknown. */
const STUCK_MINUTES = 10;
/** Stuck rows handled per run; a backlog is taken over the next runs. */
const STALE_BATCH = 200;

/**
 * The outbox job (BUILD_PLAN §12.2). Normally run by Cron through
 * `job:einvoice-send` (CLAUDE.md: no daemons, ADR-009 §15); with
 * EINVOICE_WORKER=on it also runs inside the API every
 * EINVOICE_WORKER_INTERVAL_MS (development). Each run claims due rows with one atomic UPDATE (works on MariaDB 10.4, which has
 * no SKIP LOCKED), so two API instances never send the same document, then
 * sends each one inside its tenant's context.
 *
 * In isolated mode each outbox is processed in its tenant database; shared
 * mode continues to use the control database.
 */
@Injectable()
export class EInvoiceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('EInvoiceWorker');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly fanout: TenantFanoutService,
    private readonly sender: EInvoiceSenderService,
    private readonly cls: ClsService<RequestContext>,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap() {
    if (this.config.get('EINVOICE_WORKER', { infer: true }) === 'off') return;
    const every = this.config.get('EINVOICE_WORKER_INTERVAL_MS', { infer: true });
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One run; overlapping runs in the same process are skipped. Returns how
   * many submissions it claimed (the Cron command repeats while there are some).
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const databases = await this.fanout.databases();
      if (databases.unavailable.length) {
        this.log.warn(`tenant databases unavailable: ${databases.unavailable.map(String).join(', ')}`);
      }
      let claimedCount = 0;
      for (const { client } of databases) {
        try {
          claimedCount += await this.tickDatabase(client);
        } catch (err) {
          this.log.error(`run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return claimedCount;
    } catch (err) {
      this.log.error(`run failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async tickDatabase(db: PrismaClient): Promise<number> {
      // The selected database owns this outbox in isolated mode.
      // A row cut off AFTER its XML was saved for sending may have reached
      // JoFotara: UNKNOWN, same XML on a resend. One cut off before that was
      // never sent in this claim: back to the queue.
      //
      // Rows are found with a plain read (it takes no locks) and then written by
      // primary key, with the same conditions again. A statement that scanned
      // for them would lock every SENDING row on the way, including the one the
      // other worker is finishing, and deadlock with its write. The index on
      // (status, claimed_at) makes the read cheap.
      const stale = await db.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM einvoice_submissions
         WHERE status = 'SENDING' AND claimed_at < UTC_TIMESTAMP(3) - INTERVAL ${STUCK_MINUTES} MINUTE
         ORDER BY id LIMIT ${STALE_BATCH}`;
      if (stale.length > 0) {
        const ids = Prisma.join(stale.map((r) => r.id));
        await retryWrite(
          () => db.$executeRaw`
            UPDATE einvoice_submissions
               SET status = 'UNKNOWN', claim_token = NULL, reuse_xml = TRUE, completed_at = UTC_TIMESTAMP(3),
                   errors = JSON_ARRAY(JSON_OBJECT('code', 'INTERRUPTED', 'source', 'local',
                     'message', 'Sending was interrupted; check the JoFotara portal before resending'))
             WHERE id IN (${ids}) AND status = 'SENDING' AND claimed_at < UTC_TIMESTAMP(3) - INTERVAL ${STUCK_MINUTES} MINUTE
               AND sent_at IS NOT NULL AND sent_at >= claimed_at`,
        );
        await retryWrite(
          () => db.$executeRaw`
            UPDATE einvoice_submissions
               SET status = 'PENDING', claim_token = NULL, next_attempt_at = UTC_TIMESTAMP(3)
             WHERE id IN (${ids}) AND status = 'SENDING' AND claimed_at < UTC_TIMESTAMP(3) - INTERVAL ${STUCK_MINUTES} MINUTE
               AND (sent_at IS NULL OR sent_at < claimed_at)`,
        );
      }

      // The claim works the same way: the due ids are read first, then each is
      // taken by primary key with its conditions checked again. Two workers that
      // read the same ids cannot both take a row: the second finds it SENDING.
      const token = randomUUID();
      const due = await db.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM einvoice_submissions
         WHERE (status = 'PENDING' OR (status = 'FAILED' AND attempt_count < ${MAX_AUTO_ATTEMPTS}))
           AND next_attempt_at <= UTC_TIMESTAMP(3)
         ORDER BY id LIMIT ${BATCH}`;
      if (due.length > 0) {
        // The atomic claim is what keeps two workers apart.
        await retryWrite(
          () => db.$executeRaw`
            UPDATE einvoice_submissions
               SET status = 'SENDING', claim_token = ${token}, claimed_at = UTC_TIMESTAMP(3)
             WHERE id IN (${Prisma.join(due.map((r) => r.id))})
               AND (status = 'PENDING' OR (status = 'FAILED' AND attempt_count < ${MAX_AUTO_ATTEMPTS}))
               AND next_attempt_at <= UTC_TIMESTAMP(3)`,
        );
      }
      const claimed = await db.$queryRaw<{ id: bigint; tenant_id: bigint }[]>`
        SELECT id, tenant_id FROM einvoice_submissions
         WHERE claim_token = ${token} AND status = 'SENDING' ORDER BY id`;
      const claimedCount = claimed.length;

      for (const row of claimed) {
        // The stuck-row clock starts when THIS row's send starts, not the batch's.
        // Same database row and claim token.
        await db.$executeRaw`
          UPDATE einvoice_submissions SET claimed_at = UTC_TIMESTAMP(3)
           WHERE id = ${row.id} AND claim_token = ${token} AND status = 'SENDING'`;
        await this.cls.run(async () => {
          this.cls.set('tenantId', BigInt(row.tenant_id));
          this.cls.set('jobContext', true); // no member: every branch (ADR-003 §16)
          try {
            await this.sender.send(BigInt(row.id), token);
          } catch (err) {
            // Left SENDING: the stuck-row rule above turns it UNKNOWN, never resent blindly.
            this.log.error(`submission ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
      return claimedCount;
  }
}
