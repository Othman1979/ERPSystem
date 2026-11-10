import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { EInvoiceSubmissionsQueryDto } from './dto/einvoice.dto.js';

const LIST_SELECT = {
  id: true,
  documentType: true,
  documentId: true,
  documentNo: true,
  uuid: true,
  icv: true,
  environment: true,
  status: true,
  attemptCount: true,
  errors: true,
  sentAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The e-invoice follow-up screen (0005 §13): what was sent, what JoFotara said, resend. */
@Injectable()
export class EInvoiceSubmissionsService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly audit: AuditService,
  ) {}

  async list(q: EInvoiceSubmissionsQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const [rows, counts] = await Promise.all([
      db.eInvoiceSubmission.findMany({
        where: {
          companyId,
          ...(q.status ? { status: q.status } : {}),
          ...(q.documentType ? { documentType: q.documentType } : {}),
        },
        select: LIST_SELECT,
        orderBy: { id: 'desc' },
        take: 300,
      }),
      db.eInvoiceSubmission.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } }),
    ]);
    return {
      rows,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const row = await db.eInvoiceSubmission.findFirst({
      where: { id },
      select: {
        ...LIST_SELECT,
        qrPayload: true,
        governmentUuid: true,
        requestXml: true,
        responseCode: true,
        responseBody: true,
        originalSubmission: { select: { id: true, documentNo: true, status: true } },
        attempts: {
          orderBy: { attemptNo: 'asc' },
          select: { attemptNo: true, outcome: true, httpStatus: true, message: true, startedAt: true, finishedAt: true },
        },
      },
    });
    if (!row) throw DomainError.notFound('EInvoiceSubmission', id.toString());
    return row;
  }

  /**
   * Send again by hand:
   *  - REJECTED: rebuilt from the posted document (after the data was fixed),
   *    same UUID and ICV, on the current environment;
   *  - FAILED (out of automatic attempts): the same XML;
   *  - UNKNOWN: the same XML, byte for byte — only after checking the
   *    JoFotara portal that it was not recorded (the screen asks).
   */
  async resend(id: bigint) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const row = await db.eInvoiceSubmission.findFirst({ where: { id }, select: { id: true, status: true } });
    if (!row) throw DomainError.notFound('EInvoiceSubmission', id.toString());
    if (row.status !== 'REJECTED' && row.status !== 'FAILED' && row.status !== 'UNKNOWN') {
      throw new DomainError(ErrorCode.CONFLICT, `A ${row.status} document cannot be resent`);
    }
    const settings = await db.eInvoiceSettings.findFirst({
      where: { companyId, isEnabled: true },
      select: { environment: true },
    });
    if (!settings) throw new DomainError(ErrorCode.EINVOICE_NOT_READY, 'E-invoicing is turned off');
    const rebuild = row.status === 'REJECTED';
    // Only PENDING moves on; a concurrent resend or worker run finds nothing to do.
    const updated = await db.eInvoiceSubmission.updateMany({
      where: { id, status: row.status },
      data: {
        status: 'PENDING',
        attemptCount: 0,
        nextAttemptAt: new Date(),
        claimToken: null,
        reuseXml: !rebuild,
        ...(rebuild ? { environment: settings.environment } : {}),
      },
    });
    if (updated.count === 0) throw new DomainError(ErrorCode.CONFLICT, 'The document changed; reload and try again');
    await this.audit.log({
      action: 'einvoice.resend',
      entityType: 'einvoice_submission',
      entityId: id,
      before: { status: row.status },
    });
    return this.get(id);
  }
}
