import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed, branchWhere } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage } from '../../common/paging/find-page.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { Prisma } from '../../generated/prisma/client.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { ListEInvoiceSubmissionsQueryDto } from './dto/einvoice.dto.js';

const DAY_MS = 86_400_000;

/** The start of a yyyy-mm-dd day in UTC (createdAt is stored in UTC). */
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

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

  /**
   * One numbered page (ADR-022) of the caller's branches (ADR-003 §10), plus
   * `counts` per status over the same branches and company, ignoring the
   * status filter so the tabs can show every status's number.
   */
  async list(q: ListEInvoiceSubmissionsQueryDto) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    if (q.from && q.to && q.from > q.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', { from: q.from, to: q.to });
    }
    const scope: Prisma.EInvoiceSubmissionWhereInput = { companyId, AND: [branchWhere()] };
    const where: Prisma.EInvoiceSubmissionWhereInput = {
      companyId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.documentType ? { documentType: q.documentType } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: dayStart(q.from) } : {}),
              // `to` is inclusive of the whole day (UTC): strictly before the next midnight.
              ...(q.to ? { lt: new Date(dayStart(q.to).getTime() + DAY_MS) } : {}),
            },
          }
        : {}),
      AND: [branchWhere(), q.q ? { documentNo: { contains: q.q } } : {}],
    };
    const orderBy = orderByOf<'createdAt' | 'documentNo', Prisma.EInvoiceSubmissionOrderByWithRelationInput>(
      q.sort,
      '-createdAt',
      {
        createdAt: (dir) => ({ createdAt: dir }),
        documentNo: (dir) => ({ documentNo: dir }),
      },
      (dir) => ({ id: dir }),
    );
    // The rows, the total and the status counts read on one snapshot (ADR-022 §3).
    let counts: Record<string, number> = {};
    const page = await findPage(db, pageWindow(q), {
      rows: async (tx, window) => {
        const rows = await tx.eInvoiceSubmission.findMany({ where, select: LIST_SELECT, orderBy, ...window });
        const byStatus = await tx.eInvoiceSubmission.groupBy({ by: ['status'], where: scope, _count: { _all: true } });
        counts = Object.fromEntries(byStatus.map((c) => [c.status, c._count._all]));
        return rows;
      },
      count: (tx) => tx.eInvoiceSubmission.count({ where }),
    });
    return { ...page, counts };
  }

  /** One submission; another branch's answers 404 like another tenant's (ADR-003 §11). */
  async get(id: bigint) {
    const { db } = this.support.tenant();
    const row = await db.eInvoiceSubmission.findFirst({
      where: { id, AND: [branchWhere()] },
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
    const row = await db.eInvoiceSubmission.findFirst({ where: { id }, select: { id: true, status: true, branchId: true } });
    if (!row) throw DomainError.notFound('EInvoiceSubmission', id.toString());
    // A write on another branch's document is refused, as for every write (ADR-003 §3, §11).
    assertBranchAllowed(row.branchId);
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
