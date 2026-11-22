import { Injectable } from '@nestjs/common';
import { ClsServiceManager, CLS_REQ } from 'nestjs-cls';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';

const AUDIT_IP_MAX_LENGTH = 64;
const AUDIT_USER_AGENT_MAX_LENGTH = 512;

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
 * Writes audit_log rows. Platform-level events use the system client, while
 * entries passed a transaction share the transaction's atomic boundary.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const request = cls.get(CLS_REQ) as
      | { ip?: string; headers?: Record<string, string | string[] | undefined> }
      | undefined;
    const data = {
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
    };
    data.ip = data.ip?.slice(0, AUDIT_IP_MAX_LENGTH) ?? null;
    data.userAgent = data.userAgent?.slice(0, AUDIT_USER_AGENT_MAX_LENGTH) ?? null;
    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    if (data.tenantId === null) {
      await this.prisma.control().auditLog.create({ data });
      return;
    }
    await this.prisma.router.resolve(data.tenantId);
    await this.prisma.forTenant(data.tenantId).auditLog.create({ data });
  }
}
