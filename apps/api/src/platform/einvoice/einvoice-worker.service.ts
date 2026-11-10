import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import type { Env } from '../../common/config/env.validation.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EInvoiceSenderService, MAX_AUTO_ATTEMPTS } from './einvoice-sender.service.js';

/** Rows taken per run. */
const BATCH = 20;
/** A row still SENDING after this was cut off mid-send: its answer is unknown. */
const STUCK_MINUTES = 10;

/**
 * The outbox job (BUILD_PLAN §12.2): every EINVOICE_WORKER_INTERVAL_MS it
 * claims due rows with one atomic UPDATE (works on MariaDB 10.4, which has
 * no SKIP LOCKED), so two API instances never send the same document, then
 * sends each one inside its tenant's context.
 *
 * Uses the system Prisma client on purpose: the job spans tenants
 * (BUILD_PLAN §5.3 "scheduled jobs"). It touches only einvoice_submissions;
 * everything else runs tenant-scoped in the sender. Times are UTC, as Prisma
 * writes them.
 */
@Injectable()
export class EInvoiceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('EInvoiceWorker');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
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

  /** One run; overlapping runs in the same process are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // system client: cross-tenant outbox maintenance (see class comment).
      await this.prisma.client.$executeRaw`
        UPDATE einvoice_submissions
           SET status = 'UNKNOWN', claim_token = NULL, reuse_xml = TRUE, completed_at = UTC_TIMESTAMP(3),
               errors = JSON_ARRAY(JSON_OBJECT('code', 'INTERRUPTED', 'source', 'local',
                 'message', 'Sending was interrupted; check the JoFotara portal before resending'))
         WHERE status = 'SENDING' AND claimed_at < UTC_TIMESTAMP(3) - INTERVAL ${STUCK_MINUTES} MINUTE`;

      const token = randomUUID();
      // system client: the atomic claim is what keeps two workers apart.
      await this.prisma.client.$executeRaw`
        UPDATE einvoice_submissions
           SET status = 'SENDING', claim_token = ${token}, claimed_at = UTC_TIMESTAMP(3)
         WHERE (status = 'PENDING' OR (status = 'FAILED' AND attempt_count < ${MAX_AUTO_ATTEMPTS}))
           AND next_attempt_at <= UTC_TIMESTAMP(3)
         ORDER BY id
         LIMIT ${BATCH}`;
      const claimed = await this.prisma.client.$queryRaw<{ id: bigint; tenant_id: bigint }[]>`
        SELECT id, tenant_id FROM einvoice_submissions
         WHERE claim_token = ${token} AND status = 'SENDING' ORDER BY id`;

      for (const row of claimed) {
        await this.cls.run(async () => {
          this.cls.set('tenantId', BigInt(row.tenant_id));
          try {
            await this.sender.send(BigInt(row.id));
          } catch (err) {
            // Left SENDING: the stuck-row rule above turns it UNKNOWN, never resent blindly.
            this.log.error(`submission ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
    } catch (err) {
      this.log.error(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
