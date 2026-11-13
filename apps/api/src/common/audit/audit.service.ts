import { Injectable } from '@nestjs/common';
import { ClsServiceManager, CLS_REQ } from 'nestjs-cls';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';

export interface AuditEntry {
  action: string;
  /**
   * Tenant the record belongs to. When given (even null) it replaces the tenant
   * of the CLS context: platform-admin actions pass null so they never land in
   * the admin's own company audit (PLAT-12).
   */
  tenantId?: bigint | null;
  entityType?: string;
  entityId?: string | bigint;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

/**
 * Writes audit_log rows. Always uses the SYSTEM client: audit entries may be
 * recorded for platform-level events (login failures, tenant suspension) where
 * no tenant context exists, and AuditLog.tenantId is nullable by design.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const request = cls.get(CLS_REQ) as
      | { ip?: string; headers?: Record<string, string | string[] | undefined> }
      | undefined;
    // systemPrisma: audit writes span tenants/platform events by design.
    await this.prisma.client.auditLog.create({
      data: {
        tenantId: entry.tenantId !== undefined ? entry.tenantId : (cls.get('tenantId') ?? null),
        userId: cls.get('userId') ?? null,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId?.toString() ?? null,
        beforeJson: entry.before === undefined ? undefined : (entry.before as object),
        afterJson: entry.after === undefined ? undefined : (entry.after as object),
        ip: entry.ip ?? request?.ip ?? null,
        userAgent:
          entry.userAgent ??
          (Array.isArray(request?.headers?.['user-agent'])
            ? request.headers['user-agent'][0]
            : request?.headers?.['user-agent']) ??
          null,
      },
    });
  }
}
