import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { Decimal } from '../decimal/decimal.utils.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { OWNER_ROLE } from '../permissions/member-permissions.js';
import { PERMISSIONS } from '../permissions/permissions.js';
import { lockProcurementLevel } from './procurement-level.js';

/** Who approves, and what (ADR-025 §2). */
export interface ApprovalCheck {
  /** The approval permission (default purchase.approve; sales orders use sales.approve, ADR-027 §6). */
  permission?: string;
  /** The approver's role is OWNER: always allowed, no limit, may approve their own document. */
  isOwner: boolean;
  /** The approver holds purchase.approve (read under lock in the approving transaction). */
  canApprove: boolean;
  /** The approver's limit; null = no limit. */
  limit: Decimal | null;
  /** The total compared with the limit; null for a purchase request (no binding prices). */
  amount: Decimal | null;
  /**
   * The approver authored the document: created it, made its last edit
   * (updated_by) or submitted it (submitted_by). See isAuthor.
   */
  isAuthor: boolean;
}

/** The people who authored a document: its creator, last editor and submitter. */
export interface DocumentAuthors {
  created_by: bigint | null;
  updated_by: bigint | null;
  submitted_by: bigint | null;
}

/**
 * True when `userId` created, last edited or submitted the document
 * (review #47): editing or submitting someone else's draft makes it yours
 * as well, so the approval stays with a second person.
 */
export function isAuthor(doc: DocumentAuthors, userId: bigint | null): boolean {
  if (userId === null) return false;
  return [doc.created_by, doc.updated_by, doc.submitted_by].some((u) => u !== null && u === userId);
}

/**
 * The approval rule (ADR-025 §2, ADR-024 §3.3):
 *  - an owner always approves, their own documents included, with no limit;
 *  - anyone else needs purchase.approve (FORBIDDEN), must not have authored
 *    the document (APPROVAL_SELF_NOT_ALLOWED), and, for an amount, it must be
 *    at most their limit when they have one (APPROVAL_LIMIT_EXCEEDED, the
 *    owner approves it). Compared as Decimal.
 * A rejection needs the permission only (ADR-025 forbids self-approval, not
 * turning one's own document down).
 */
export function assertCanApprove(c: ApprovalCheck): void {
  if (c.isOwner) return;
  if (!c.canApprove) {
    throw new DomainError(ErrorCode.FORBIDDEN, `Missing permission: ${c.permission ?? PERMISSIONS.PURCHASE_APPROVE}`);
  }
  if (c.isAuthor) {
    throw new DomainError(ErrorCode.APPROVAL_SELF_NOT_ALLOWED, 'You cannot approve a document you created, edited or submitted');
  }
  if (c.amount !== null && c.limit !== null && c.amount.gt(c.limit)) {
    throw new DomainError(ErrorCode.APPROVAL_LIMIT_EXCEEDED, 'The total is above your approval limit; the owner approves it', {
      amount: c.amount.toFixed(3),
      limit: c.limit.toFixed(3),
    });
  }
}

/**
 * The caller's purchase.approve grant, read with a shared lock inside the
 * approving transaction (after the document's lock), so a revoke or a limit
 * change committed meanwhile is seen and a concurrent one waits for this
 * approval. An owner needs no grant.
 */
export async function readApprover(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  permission: string = PERMISSIONS.PURCHASE_APPROVE,
): Promise<{ userId: bigint | null; isOwner: boolean; canApprove: boolean; limit: Decimal | null }> {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const userId = cls.get('userId') ?? null;
  const isOwner = cls.get('roleCode') === OWNER_ROLE;
  if (isOwner) return { userId, isOwner, canApprove: true, limit: null };
  const grant = await readMemberGrant(tx, tenantId, permission);
  return { userId, isOwner, canApprove: grant !== null, limit: grant?.limit ?? null };
}

/**
 * The caller's stored grant of a member permission (ADR-024 §3), read with a
 * shared lock on the caller's transaction: a revoke committed since the
 * request started is seen, and one racing this transaction waits for it.
 * Null when the member does not hold it (the request-start CLS set is not used).
 */
export async function readMemberGrant(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  code: string,
): Promise<{ limit: Decimal | null } | null> {
  const membershipId = ClsServiceManager.getClsService<RequestContext>().get('membershipId');
  if (membershipId === undefined) return null;
  const [grant] = await tx.$queryRaw<{ amount_limit: { toString(): string } | null }[]>`
    SELECT amount_limit FROM member_permissions
     WHERE tenant_id = ${tenantId} AND membership_id = ${membershipId}
       AND permission_code = ${code}
     LOCK IN SHARE MODE`;
  if (!grant) return null;
  return { limit: grant.amount_limit != null ? new Decimal(grant.amount_limit.toString()) : null };
}

/**
 * ADR-025 §4: at MEDIUM or FULL, a purchase invoice is a direct purchase
 * (until phase 13 links invoices to orders, every one is), and anyone but an
 * owner needs purchase.direct to create or post it (PURCHASE_DIRECT_REQUIRED).
 * SIMPLE is not affected. The level is read under the company row's shared
 * lock, and the grant under a shared lock of member_permissions, both inside
 * the caller's transaction.
 */
export async function assertDirectPurchaseAllowed(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  companyId: bigint,
): Promise<void> {
  const level = await lockProcurementLevel(tx, tenantId, companyId);
  if (level === 'SIMPLE') return;
  const cls = ClsServiceManager.getClsService<RequestContext>();
  if (cls.get('roleCode') === OWNER_ROLE) return;
  if (await readMemberGrant(tx, tenantId, PERMISSIONS.PURCHASE_DIRECT)) return;
  throw new DomainError(
    ErrorCode.PURCHASE_DIRECT_REQUIRED,
    `A purchase invoice without a purchase order needs ${PERMISSIONS.PURCHASE_DIRECT} at the ${level} procurement level`,
    { level },
  );
}
