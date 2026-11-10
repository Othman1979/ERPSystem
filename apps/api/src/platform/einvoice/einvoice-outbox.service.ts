import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { resolveBuyer, type BuyerSource } from './buyer.js';

export type EInvoiceDocumentType = 'SALES_INVOICE' | 'SALES_RETURN';

/**
 * The posting side of JoFotara (0005 §13): checks a document can be sent
 * and queues it inside its posting transaction. It never calls JoFotara —
 * the worker does, after the transaction has committed. When e-invoicing is
 * off for the company every method is a no-op, so posting is unchanged.
 * Writes only the e-invoice tables (module boundary).
 */
@Injectable()
export class EInvoiceOutboxService {
  constructor(private readonly support: DocumentSupportService) {}

  /** The company's settings while e-invoicing is on (a plain read: no lock while it is off). */
  private enabledSettings(tx: Prisma.TransactionClient, companyId: bigint) {
    return tx.eInvoiceSettings.findFirst({ where: { companyId, isEnabled: true } });
  }

  /**
   * Locks the settings row and reads the ICV counter WITH the lock. A plain
   * read here would return the transaction's REPEATABLE READ snapshot, taken
   * before it waited, so two postings at once would draw the same ICV.
   */
  private async lockCounter(tx: Prisma.TransactionClient, companyId: bigint) {
    const { tenantId } = this.support.tenant();
    const [row] = await tx.$queryRaw<
      { id: bigint; next_icv: number; environment: 'SANDBOX' | 'PRODUCTION'; is_enabled: number | boolean }[]
    >`SELECT id, next_icv, environment, is_enabled FROM einvoice_settings
       WHERE tenant_id = ${tenantId} AND company_id = ${companyId} FOR UPDATE`;
    return row && Boolean(row.is_enabled) ? row : null;
  }

  /**
   * Posting check for a sales invoice (0005 §11): the buyer rules, and every
   * line must be sendable as it will be posted — an invoice JoFotara cannot
   * take would be posted and then stuck, as posted invoices are not reversed.
   */
  async assertInvoiceSendable(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    input: {
      paymentType: 'CASH' | 'CREDIT';
      grandTotal: Decimal.Value;
      buyer: BuyerSource;
      lines: { taxRate: Decimal.Value; taxAmount: Decimal.Value; einvoiceCode: string | null }[];
    },
  ): Promise<void> {
    const settings = await this.enabledSettings(tx, companyId);
    if (!settings) return;
    const r = resolveBuyer(input.buyer, input.paymentType, input.grandTotal);
    if (!r.ok) throw new DomainError(ErrorCode.EINVOICE_BUYER_REQUIRED, r.reason);
    for (const l of input.lines) {
      if (settings.track === 'INCOME') {
        if (!new Decimal(l.taxAmount).isZero()) {
          throw new DomainError(
            ErrorCode.EINVOICE_NOT_READY,
            'The company is on the income track (not registered for sales tax): its invoices cannot carry tax',
          );
        }
        continue;
      }
      const code = l.einvoiceCode?.trim().toUpperCase();
      if (new Decimal(l.taxRate).isZero() && code !== 'Z' && code !== 'O') {
        throw new DomainError(
          ErrorCode.EINVOICE_NOT_READY,
          'A 0% tax category needs its e-invoice code: Z (exempt) or O (zero-rated). Set it in Settings → Taxes',
        );
      }
    }
  }

  /** Posting check for a sales return that will be sent: it needs a reason (p.26). */
  async assertReturnSendable(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    input: { originalInvoiceId: bigint; reason: string | null },
  ): Promise<void> {
    if (!(await this.enabledSettings(tx, companyId))) return;
    const original = await tx.eInvoiceSubmission.findFirst({
      where: { documentType: 'SALES_INVOICE', documentId: input.originalInvoiceId },
      select: { id: true },
    });
    if (original && !input.reason?.trim()) {
      throw new DomainError(ErrorCode.EINVOICE_REASON_REQUIRED, 'A return sent to JoFotara needs a reason');
    }
  }

  /**
   * Queue a posted document: a new UUID, the next ICV and a PENDING row,
   * all inside the posting transaction (BUILD_PLAN §12.2). A return is
   * queued only when its original invoice was; one posted before
   * e-invoicing was turned on is not sent, and neither are its returns.
   */
  async enqueue(
    tx: Prisma.TransactionClient,
    input: {
      companyId: bigint;
      documentType: EInvoiceDocumentType;
      documentId: bigint;
      documentNo: string;
      originalInvoiceId?: bigint;
    },
  ): Promise<{ id: bigint } | null> {
    const { tenantId } = this.support.tenant();
    if (!(await this.enabledSettings(tx, input.companyId))) return null;
    const counter = await this.lockCounter(tx, input.companyId);
    if (!counter) return null;

    let originalSubmissionId: bigint | null = null;
    if (input.documentType === 'SALES_RETURN') {
      const original = await tx.eInvoiceSubmission.findFirst({
        where: { documentType: 'SALES_INVOICE', documentId: input.originalInvoiceId },
        select: { id: true },
      });
      if (!original) return null;
      originalSubmissionId = original.id;
    }

    await tx.eInvoiceSettings.update({ where: { id: counter.id }, data: { nextIcv: { increment: 1 } } });
    return tx.eInvoiceSubmission.create({
      data: {
        tenantId,
        companyId: input.companyId,
        documentType: input.documentType,
        documentId: input.documentId,
        documentNo: input.documentNo,
        uuid: randomUUID(),
        icv: Number(counter.next_icv),
        environment: counter.environment,
        status: 'PENDING',
        nextAttemptAt: new Date(),
        originalSubmissionId,
      },
      select: { id: true },
    });
  }

  /** The e-invoice state shown with a document (null when it was not sent). */
  async stateOf(documentType: EInvoiceDocumentType, documentId: bigint) {
    const { db } = this.support.tenant();
    return db.eInvoiceSubmission.findFirst({
      where: { documentType, documentId },
      select: {
        id: true,
        status: true,
        uuid: true,
        icv: true,
        environment: true,
        qrPayload: true,
        errors: true,
        completedAt: true,
      },
    });
  }
}
