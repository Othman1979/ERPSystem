import { Injectable } from '@nestjs/common';
import { ClsServiceManager, CLS_REQ } from 'nestjs-cls';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { assertBranchAllowed } from '../../common/branch/branch-context.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import type { DocumentLockDocType } from './document-locks.dto.js';

const LEASE_SECONDS = 120;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DOCUMENTS: Record<
  DocumentLockDocType,
  { editPermission: string; readPermission: string }
> = {
  JOURNAL_ENTRY: {
    editPermission: PERMISSIONS.JOURNAL_POST,
    readPermission: PERMISSIONS.TENANT_READ,
  },
  RECEIPT: {
    editPermission: PERMISSIONS.TREASURY_MANAGE,
    readPermission: PERMISSIONS.TENANT_READ,
  },
  PAYMENT: {
    editPermission: PERMISSIONS.TREASURY_MANAGE,
    readPermission: PERMISSIONS.TENANT_READ,
  },
  SALES_INVOICE: {
    editPermission: PERMISSIONS.SALES_MANAGE,
    readPermission: PERMISSIONS.TENANT_READ,
  },
  PURCHASE_INVOICE: {
    editPermission: PERMISSIONS.PURCHASE_MANAGE,
    readPermission: PERMISSIONS.TENANT_READ,
  },
};

export interface DocumentLockTarget {
  lockForEdit(tx: Prisma.TransactionClient, docId: bigint): Promise<{ branchId: bigint | null }>;
  find(
    db: PrismaService['client'] | Prisma.TransactionClient,
    docId: bigint,
  ): Promise<{ branchId: bigint | null }>;
}

interface LockRow {
  id: bigint;
  user_id: bigint;
  holder_token: string;
  acquired_at: Date;
  expires_at: Date;
  is_live: number | boolean;
  user_name: string;
}

interface LeaseRow {
  acquired_at: Date;
  expires_at: Date;
}

// Joined tables are tenant-local, so raw lock queries use the resolved tenant client.
@Injectable()
export class DocumentLocksService {
  private readonly targets = new Map<DocumentLockDocType, DocumentLockTarget>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  registerTarget(docType: DocumentLockDocType, target: DocumentLockTarget): void {
    if (this.targets.has(docType)) throw new Error(`Document lock target already registered for ${docType}`);
    this.targets.set(docType, target);
  }

  async acquire(docType: DocumentLockDocType, docId: bigint, token?: string) {
    const { tenantId, companyId, userId, permissions } = this.context();
    this.requirePermission(permissions, DOCUMENTS[docType].editPermission);
    const holderToken = this.requireToken(token);
    const prisma = await this.tenantClient(tenantId);

    return this.withRetry(() =>
      prisma.$transaction(async (tx) => {
        await this.lockDocument(tx, docType, docId);
        const [row] = await tx.$queryRaw<LockRow[]>`
          SELECT l.id, l.user_id, l.holder_token, l.acquired_at, l.expires_at,
                 (l.expires_at > NOW(3)) AS is_live, u.full_name AS user_name
            FROM document_edit_locks l
            JOIN tenant_memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id
            JOIN users u ON u.id = m.user_id
           WHERE l.tenant_id = ${tenantId} AND l.company_id = ${companyId}
             AND l.doc_type = ${docType} AND l.doc_id = ${docId}
           FOR UPDATE`;

        if (!row) {
          await tx.$executeRaw`
            INSERT INTO document_edit_locks
              (tenant_id, company_id, doc_type, doc_id, user_id, holder_token, acquired_at, heartbeat_at, expires_at)
            VALUES
              (${tenantId}, ${companyId}, ${docType}, ${docId}, ${userId}, ${holderToken},
               NOW(3), NOW(3), DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND))`;
        } else {
          const live = Boolean(Number(row.is_live));
          const sameHolder = row.user_id === userId && row.holder_token === holderToken;
          if (live && !sameHolder) {
            throw this.lockedError(row);
          }
          if (live) {
            await tx.$executeRaw`
              UPDATE document_edit_locks
                 SET heartbeat_at = NOW(3), expires_at = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND)
               WHERE tenant_id = ${tenantId} AND id = ${row.id}`;
          } else {
            await tx.$executeRaw`
              UPDATE document_edit_locks
                 SET user_id = ${userId}, holder_token = ${holderToken}, acquired_at = NOW(3),
                     heartbeat_at = NOW(3), expires_at = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND)
               WHERE tenant_id = ${tenantId} AND id = ${row.id}`;
          }
        }

        const [lease] = await tx.$queryRaw<LeaseRow[]>`
          SELECT acquired_at, expires_at FROM document_edit_locks
           WHERE tenant_id = ${tenantId} AND company_id = ${companyId}
             AND doc_type = ${docType} AND doc_id = ${docId}`;
        if (!lease) throw new DomainError(ErrorCode.INTERNAL, 'Document lock was not created');
        return { acquiredAt: lease.acquired_at, expiresAt: lease.expires_at };
      }, { timeout: 30_000 }),
    );
  }

  async heartbeat(docType: DocumentLockDocType, docId: bigint, token?: string) {
    const { tenantId, companyId, userId, permissions } = this.context();
    this.requirePermission(permissions, DOCUMENTS[docType].editPermission);
    const holderToken = this.requireToken(token);
    const prisma = await this.tenantClient(tenantId);

    return prisma.$transaction(async (tx) => {
      await this.readDocument(tx, docType, docId);
      const updated = await tx.$executeRaw`
        UPDATE document_edit_locks
           SET heartbeat_at = NOW(3), expires_at = DATE_ADD(NOW(3), INTERVAL ${LEASE_SECONDS} SECOND)
         WHERE tenant_id = ${tenantId} AND company_id = ${companyId}
           AND doc_type = ${docType} AND doc_id = ${docId}
           AND user_id = ${userId} AND holder_token = ${holderToken}
           AND expires_at > NOW(3)`;
      if (updated !== 1) {
        throw new DomainError(ErrorCode.DOCUMENT_LOCK_REQUIRED, 'A live document lock is required');
      }
      const [lease] = await tx.$queryRaw<LeaseRow[]>`
        SELECT acquired_at, expires_at FROM document_edit_locks
         WHERE tenant_id = ${tenantId} AND company_id = ${companyId}
           AND doc_type = ${docType} AND doc_id = ${docId}
           AND user_id = ${userId} AND holder_token = ${holderToken}`;
      if (!lease) throw new DomainError(ErrorCode.DOCUMENT_LOCK_REQUIRED, 'A live document lock is required');
      return { acquiredAt: lease.acquired_at, expiresAt: lease.expires_at };
    });
  }

  async release(docType: DocumentLockDocType, docId: bigint, token?: string): Promise<void> {
    const { tenantId, companyId, userId } = this.context();
    const holderToken = token && this.validToken(token) ? token : null;
    if (!holderToken) return;
    const prisma = await this.tenantClient(tenantId);
    await prisma.documentEditLock.deleteMany({
      where: { tenantId, companyId, docType, docId, userId, holderToken },
    });
  }

  async forceRelease(docType: DocumentLockDocType, docId: bigint) {
    const { tenantId, companyId, permissions } = this.context();
    this.requirePermission(permissions, PERMISSIONS.DOCUMENT_UNLOCK);
    const prisma = await this.tenantClient(tenantId);

    return prisma.$transaction(async (tx) => {
      await this.lockDocument(tx, docType, docId);
      const [row] = await tx.$queryRaw<LockRow[]>`
        SELECT l.id, l.user_id, l.holder_token, l.acquired_at, l.expires_at,
               (l.expires_at > NOW(3)) AS is_live, u.full_name AS user_name
          FROM document_edit_locks l
          JOIN tenant_memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id
          JOIN users u ON u.id = m.user_id
         WHERE l.tenant_id = ${tenantId} AND l.company_id = ${companyId}
           AND l.doc_type = ${docType} AND l.doc_id = ${docId}
         FOR UPDATE`;
      if (!row) return { released: false };
      await tx.documentEditLock.deleteMany({ where: { tenantId, id: row.id } });
      await this.audit.log(
        {
          action: 'document_lock.force_release',
          entityType: docType.toLowerCase(),
          entityId: docId,
          before: {
            userId: row.user_id.toString(),
            userName: row.user_name,
            acquiredAt: row.acquired_at.toISOString(),
          },
        },
        tx,
      );
      return { released: true };
    });
  }

  async status(docType: DocumentLockDocType, docId: bigint) {
    const { tenantId, companyId, userId, permissions, holderToken } = this.context();
    this.requirePermission(permissions, DOCUMENTS[docType].readPermission);
    const token = this.requestToken(holderToken);
    const prisma = await this.tenantClient(tenantId);
    await this.readDocument(prisma, docType, docId);
    const [row] = await prisma.$queryRaw<LockRow[]>`
      SELECT l.id, l.user_id, l.holder_token, l.acquired_at, l.expires_at,
             (l.expires_at > NOW(3)) AS is_live, u.full_name AS user_name
        FROM document_edit_locks l
        JOIN tenant_memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id
        JOIN users u ON u.id = m.user_id
       WHERE l.tenant_id = ${tenantId} AND l.company_id = ${companyId}
         AND l.doc_type = ${docType} AND l.doc_id = ${docId}
         AND l.expires_at > NOW(3)`;
    if (!row) return { holder: null };
    return {
      holder: {
        userName: row.user_name,
        acquiredAt: row.acquired_at,
        expiresAt: row.expires_at,
        mine: row.user_id === userId && token !== null && row.holder_token === token,
      },
    };
  }

  async requireHeld(
    tx: Prisma.TransactionClient,
    docType: DocumentLockDocType,
    docId: bigint,
  ): Promise<void> {
    const { tenantId, companyId, userId, holderToken } = this.context();
    const token = this.requestToken(holderToken);
    if (!token) {
      throw new DomainError(ErrorCode.DOCUMENT_LOCK_REQUIRED, 'A live document lock is required');
    }
    const [row] = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM document_edit_locks
       WHERE tenant_id = ${tenantId} AND company_id = ${companyId}
         AND doc_type = ${docType} AND doc_id = ${docId}
         AND user_id = ${userId} AND holder_token = ${token}
         AND expires_at > NOW(3)
       FOR UPDATE`;
    if (!row) {
      throw new DomainError(ErrorCode.DOCUMENT_LOCK_REQUIRED, 'A live document lock is required');
    }
    await tx.documentEditLock.deleteMany({ where: { tenantId, id: row.id } });
  }

  async assertNotLockedByOther(
    tx: Prisma.TransactionClient,
    docType: DocumentLockDocType,
    docId: bigint,
  ): Promise<void> {
    const { tenantId, companyId, userId, holderToken } = this.context();
    const token = this.requestToken(holderToken);
    const [row] = await tx.$queryRaw<LockRow[]>`
      SELECT l.id, l.user_id, l.holder_token, l.acquired_at, l.expires_at,
             (l.expires_at > NOW(3)) AS is_live, u.full_name AS user_name
        FROM document_edit_locks l
        JOIN tenant_memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id
        JOIN users u ON u.id = m.user_id
       WHERE l.tenant_id = ${tenantId} AND l.company_id = ${companyId}
         AND l.doc_type = ${docType} AND l.doc_id = ${docId}
         AND l.expires_at > NOW(3)
       FOR UPDATE`;
    if (row && !(row.user_id === userId && token !== null && row.holder_token === token)) {
      throw this.lockedError(row);
    }
  }

  private async lockDocument(
    tx: Prisma.TransactionClient,
    docType: DocumentLockDocType,
    docId: bigint,
  ): Promise<void> {
    const { branchId } = await this.target(docType).lockForEdit(tx, docId);
    assertBranchAllowed(branchId);
  }

  private async readDocument(
    db: PrismaService['client'] | Prisma.TransactionClient,
    docType: DocumentLockDocType,
    docId: bigint,
  ): Promise<void> {
    const { branchId } = await this.target(docType).find(db, docId);
    assertBranchAllowed(branchId);
  }

  private target(docType: DocumentLockDocType): DocumentLockTarget {
    const target = this.targets.get(docType);
    if (!target) throw new DomainError(ErrorCode.INTERNAL, `Document lock target is not registered for ${docType}`);
    return target;
  }

  private async tenantClient(tenantId: bigint) {
    await this.prisma.router.resolve(tenantId);
    return this.prisma.forTenant(tenantId);
  }

  private lockedError(row: LockRow): DomainError {
    return new DomainError(ErrorCode.DOCUMENT_LOCKED, 'Document is locked for editing', {
      userName: row.user_name,
      acquiredAt: row.acquired_at,
    });
  }

  private context() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const companyId = cls.get('companyId');
    const userId = cls.get('userId');
    if (tenantId === undefined || companyId === undefined || userId === undefined) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Document locks require an active tenant, company, and user');
    }
    return {
      tenantId,
      companyId,
      userId,
      permissions: cls.get('permissions') ?? new Set<string>(),
      holderToken: cls.get(CLS_REQ) as { headers?: Record<string, string | string[] | undefined> } | undefined,
    };
  }

  private requestToken(request: { headers?: Record<string, string | string[] | undefined> } | undefined): string | null {
    const value = request?.headers?.['x-edit-lock'];
    const token = Array.isArray(value) ? value[0] : value;
    return token && this.validToken(token) ? token : null;
  }

  private requireToken(token?: string): string {
    if (!token || !this.validToken(token)) {
      throw new DomainError(ErrorCode.VALIDATION, 'X-Edit-Lock must be a UUID', { field: 'X-Edit-Lock' });
    }
    return token;
  }

  private validToken(token: string): boolean {
    return LOCK_TOKEN_PATTERN.test(token);
  }

  private requirePermission(permissions: ReadonlySet<string>, permission: string): void {
    if (!permissions.has(permission)) {
      throw new DomainError(ErrorCode.FORBIDDEN, `Missing permission: ${permission}`);
    }
  }

  private async withRetry<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const candidate = error as { code?: string; message?: string; meta?: { code?: string } };
        const retryable =
          candidate.code === 'P2002' ||
          candidate.code === 'P2034' ||
          candidate.meta?.code === '1062' ||
          candidate.meta?.code === '1213' ||
          candidate.message?.toLowerCase().includes('deadlock') ||
          candidate.message?.toLowerCase().includes('duplicate entry');
        if (!retryable || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }
}
