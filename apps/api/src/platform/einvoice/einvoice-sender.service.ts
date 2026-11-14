import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SubmitOutcome } from 'jofotara-kit';
import type { Env } from '../../common/config/env.validation.js';
import { DomainError } from '../../common/errors/domain.error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { EInvoiceBuildError, EInvoiceDocumentsService } from './einvoice-documents.service.js';
import { retryWrite } from './einvoice-retry.js';
import { EInvoiceSettingsService } from './einvoice-settings.service.js';

/** Automatic attempts while the server cannot be reached (BUILD_PLAN §12.2). */
export const MAX_AUTO_ATTEMPTS = 5;
/** A return waits this long before checking its original again. */
const WAIT_FOR_ORIGINAL_MS = 60_000;

type ErrorItem = { code: string; message: string; source: 'jofotara' | 'local' };

interface FinishData {
  status: 'ACCEPTED' | 'REJECTED' | 'FAILED' | 'UNKNOWN';
  errors?: ErrorItem[] | null;
  qrPayload?: string;
  governmentUuid?: string | null;
  responseCode?: number | null;
  responseBody?: string | null;
  nextAttemptAt?: Date;
  reuseXml?: boolean;
}

/** 1, 2, 4, 8 … minutes after the n-th failed attempt. */
export const backoffMs = (attempt: number) => 60_000 * 2 ** Math.max(0, attempt - 1);

/**
 * Sends ONE claimed submission (status SENDING) and records the answer
 * (0005 §13). Outcomes come from jofotara-kit's client:
 *  - accepted → ACCEPTED, with the QR and the raw answer;
 *  - rejected, or invalid before sending → REJECTED, never resent automatically;
 *  - not sent because the server was unreachable → FAILED, retried with backoff (5 at most);
 *  - unknown (timeout, unreadable, no proof either way) → UNKNOWN, never resent
 *    automatically: JoFotara may have recorded it.
 * The XML is saved BEFORE it is sent, so a retry can reuse it byte for byte.
 */
@Injectable()
export class EInvoiceSenderService {
  private readonly log = new Logger('EInvoice');

  constructor(
    private readonly support: DocumentSupportService,
    private readonly settings: EInvoiceSettingsService,
    private readonly documents: EInvoiceDocumentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * `claimToken` is the worker's claim on the row: every write below is
   * guarded by it, so a row the stuck-row rule or a resend took over is
   * never overwritten, and never sent, by a run that lost it.
   */
  async send(submissionId: bigint, claimToken: string): Promise<void> {
    const { db } = this.support.tenant();
    const sub = await db.eInvoiceSubmission.findFirst({
      where: { id: submissionId, status: 'SENDING', claimToken },
      include: {
        originalSubmission: { select: { status: true, documentNo: true, uuid: true, documentId: true, requestXml: true } },
      },
    });
    if (!sub) return;
    const finish = (attemptCount: number, data: FinishData) => this.finish(db, sub.id, claimToken, attemptCount, data);

    // A return is sent only after its original invoice is accepted (§12.2).
    if (sub.originalSubmission && sub.originalSubmission.status !== 'ACCEPTED') {
      // Still on its way: look again soon. Stopped (rejected, unknown): look rarely.
      const moving = ['PENDING', 'SENDING', 'FAILED'].includes(sub.originalSubmission.status);
      await retryWrite(() =>
        db.eInvoiceSubmission.updateMany({
          where: { id: sub.id, claimToken },
          data: {
            status: 'PENDING',
            claimToken: null,
            nextAttemptAt: new Date(Date.now() + (moving ? WAIT_FOR_ORIGINAL_MS : 10 * WAIT_FOR_ORIGINAL_MS)),
          },
        }),
      );
      return;
    }

    // A refused connection (disabled, production not allowed) is a retry, not a crash:
    // a throw here would leave the row SENDING until the stuck-row rule marks it UNKNOWN.
    let conn: Awaited<ReturnType<EInvoiceSettingsService['connection']>>;
    try {
      conn = await this.settings.connection(sub.companyId);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      const attempts = sub.attemptCount + 1;
      return finish(attempts, {
        status: 'FAILED',
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        errors: [{ code: 'NOT_CONFIGURED', message: err.message, source: 'local' }],
      });
    }
    if (!conn) {
      const attempts = sub.attemptCount + 1;
      return finish(attempts, {
        status: 'FAILED',
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        errors: [{ code: 'NOT_CONFIGURED', message: 'E-invoicing credentials or EINVOICE_ENC_KEY are missing', source: 'local' }],
      });
    }
    if (conn.environment !== sub.environment) {
      return finish(sub.attemptCount, {
        status: 'REJECTED',
        errors: [
          {
            code: 'ENVIRONMENT_CHANGED',
            message: `Queued for ${sub.environment}, but e-invoicing now uses ${conn.environment}. Resend it to send it there.`,
            source: 'local',
          },
        ],
      });
    }

    let xml: string;
    if (sub.reuseXml && sub.requestXml) {
      xml = sub.requestXml;
    } else {
      try {
        xml = await this.documents.buildXml(sub, conn);
      } catch (err) {
        if (!(err instanceof EInvoiceBuildError)) throw err;
        return finish(sub.attemptCount, {
          status: 'REJECTED',
          errors: [{ code: 'NOT_SENDABLE', message: err.message, source: 'local' }],
        });
      }
    }

    const attemptNo = (await db.eInvoiceAttempt.count({ where: { submissionId: sub.id } })) + 1;
    const startedAt = new Date();
    // Saved BEFORE sending, and only while we still hold the claim: no claim, no send.
    const owned = await retryWrite(() =>
      db.eInvoiceSubmission.updateMany({
        where: { id: sub.id, claimToken, status: 'SENDING' },
        data: { requestXml: xml, sentAt: startedAt },
      }),
    );
    if (owned.count === 0) return;

    const client = createClient({
      baseUrl: conn.baseUrl,
      clientId: conn.clientId,
      secretKey: conn.secretKey,
      timeoutMs: this.config.get('EINVOICE_HTTP_TIMEOUT_MS', { infer: true }),
      validateBeforeSending: true,
    });
    let outcome: SubmitOutcome;
    try {
      outcome = await client.submit(xml);
    } catch (err) {
      // The kit sorts every answer; a throw here is our side. It may have been sent.
      outcome = { status: 'unknown', reason: 'network', message: err instanceof Error ? err.message : String(err) };
    }
    const finishedAt = new Date();

    // JoFotara has answered: from here on, the answer is recorded even if a write loses a deadlock.
    await retryWrite(() =>
      db.eInvoiceAttempt.create({
        data: {
          tenantId: sub.tenantId,
          submissionId: sub.id,
          attemptNo,
          outcome: outcome.status,
          httpStatus: 'httpStatus' in outcome ? (outcome.httpStatus ?? null) : null,
          responseBody: 'raw' in outcome ? (outcome.raw ?? null) : null,
          message: summary(outcome).slice(0, 1000),
          startedAt,
          finishedAt,
        },
      }),
    );
    // Logged without the request, headers or credentials.
    this.log.log(`${sub.documentType} ${sub.documentNo} (icv ${sub.icv}): ${outcome.status}`);

    const autoAttempts = sub.attemptCount + 1;
    switch (outcome.status) {
      case 'accepted':
        return finish(autoAttempts, {
          status: 'ACCEPTED',
          qrPayload: outcome.qr,
          governmentUuid: outcome.governmentUuid ?? null,
          responseCode: outcome.httpStatus,
          responseBody: outcome.raw,
          errors: outcome.warnings.length ? outcome.warnings.map((w) => ({ ...w, source: 'jofotara' as const })) : null,
        });
      case 'rejected':
        return finish(autoAttempts, {
          status: 'REJECTED',
          responseCode: outcome.httpStatus,
          responseBody: outcome.raw,
          errors: outcome.errors.map((e) => ({ code: e.code, message: e.message, source: 'jofotara' as const })),
        });
      case 'unknown':
        return finish(autoAttempts, {
          status: 'UNKNOWN',
          reuseXml: true,
          responseCode: outcome.httpStatus ?? null,
          responseBody: outcome.raw ?? null,
          errors: [{ code: outcome.reason.toUpperCase(), message: outcome.message, source: 'local' }],
        });
      case 'not-sent':
        if (outcome.reason === 'invalid') {
          return finish(autoAttempts, {
            status: 'REJECTED',
            errors: (outcome.findings ?? [])
              .filter((f) => f.severity === 'error')
              .map((f) => ({ code: f.rule, message: f.message, source: 'local' as const })),
          });
        }
        return finish(autoAttempts, {
          status: 'FAILED',
          nextAttemptAt: new Date(Date.now() + backoffMs(autoAttempts)),
          reuseXml: true,
          errors: [{ code: 'UNREACHABLE', message: outcome.message, source: 'local' }],
        });
    }
  }

  /**
   * Records the result, only while `claimToken` still owns the row.
   * `reuseXml`: true once this attempt's XML was saved and (maybe) sent, so
   * the next send repeats it byte for byte; undefined leaves it as it was.
   */
  private async finish(
    db: Prisma.TransactionClient,
    id: bigint,
    claimToken: string,
    attemptCount: number,
    data: FinishData,
  ): Promise<void> {
    const { errors, reuseXml, ...rest } = data;
    // Retried when it loses a deadlock to the other worker's claim or recovery: a lost answer would
    // leave the row SENDING until the stuck-row rule turns it UNKNOWN, accepted or not.
    await retryWrite(() =>
      db.eInvoiceSubmission.updateMany({
        where: { id, claimToken },
        data: {
          ...rest,
          attemptCount,
          errors: errors === undefined ? undefined : errors === null ? ([] as Prisma.InputJsonValue) : errors,
          claimToken: null,
          ...(reuseXml === undefined ? {} : { reuseXml }),
          completedAt: data.status === 'FAILED' ? null : new Date(),
        },
      }),
    );
  }
}

function summary(o: SubmitOutcome): string {
  switch (o.status) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return o.errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'rejected';
    default:
      return o.message;
  }
}
