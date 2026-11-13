import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ClientErrorDto, ListErrorsQueryDto } from './dto/monitoring.dto.js';
import { ErrorEventsService } from './error-events.service.js';

/** Rows the console lists at once (newest first). */
const LIST_LIMIT = 200;

type ErrorRow = {
  id: bigint;
  source: string;
  name: string;
  message: string;
  method: string | null;
  path: string | null;
  status: number | null;
  tenantId: bigint | null;
  userId: bigint | null;
  requestId: string | null;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
};

const wire = (e: ErrorRow) => ({
  ...e,
  id: e.id.toString(),
  tenantId: e.tenantId?.toString() ?? null,
  userId: e.userId?.toString() ?? null,
});

/**
 * Error monitoring (ADR-010 §10.3): the web app's reports, and the platform
 * console's list. systemPrisma: a platform table across tenants (allowed in
 * `platform`); the console endpoints are platform-admin only.
 */
@Injectable()
export class MonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly errors: ErrorEventsService,
  ) {}

  /** An error caught in the browser of a signed-in user. */
  async reportClientError(dto: ClientErrorDto): Promise<void> {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    await this.errors.record({
      source: 'WEB',
      error: { name: dto.name ?? 'Error', message: dto.message, stack: dto.stack },
      path: dto.page ?? null,
      tenantId: cls.get('tenantId') ?? null,
      userId: cls.get('userId') ?? null,
    });
  }

  async list(q: ListErrorsQueryDto) {
    const status = q.status ?? 'open';
    const rows = await this.prisma.client.errorEvent.findMany({
      where: {
        ...(status === 'open' ? { resolvedAt: null } : status === 'resolved' ? { resolvedAt: { not: null } } : {}),
        ...(q.source ? { source: q.source } : {}),
      },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      omit: { stack: true, fingerprint: true, notifiedAt: true },
    });
    return rows.map(wire);
  }

  async get(id: bigint) {
    const row = await this.prisma.client.errorEvent.findUnique({ where: { id }, omit: { fingerprint: true, notifiedAt: true } });
    if (!row) throw DomainError.notFound('ErrorEvent', id.toString());
    return { ...wire(row), stack: row.stack };
  }

  /** Marks it resolved; the next occurrence reopens it. */
  async setResolved(id: bigint, resolved: boolean) {
    const row = await this.prisma.client.errorEvent.findUnique({ where: { id }, select: { id: true, resolvedAt: true } });
    if (!row) throw DomainError.notFound('ErrorEvent', id.toString());
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    // A platform action: audited with no tenant, whatever company the admin has open
    // (AuditService would file it under that tenant, into its audit export).
    await this.prisma.client.$transaction([
      this.prisma.client.errorEvent.update({ where: { id }, data: { resolvedAt: resolved ? new Date() : null } }),
      this.prisma.client.auditLog.create({
        data: {
          tenantId: null,
          userId,
          action: resolved ? 'admin.error_resolve' : 'admin.error_reopen',
          entityType: 'error_event',
          entityId: id.toString(),
          beforeJson: { resolved: row.resolvedAt !== null },
          afterJson: { resolved },
        },
      }),
    ]);
    return this.get(id);
  }
}
