import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Row locks of the procurement documents, always taken in one order so two
 * transactions never wait on each other in a cycle (§10.1):
 *
 *   company (shared, the level) → purchase request → its lines (id order)
 *   → the quote or order being changed → member_permissions (shared) → sequence.
 *
 * Every lock is a locking read taken before the transaction's first plain
 * read, so the plain reads that follow see everything committed before the
 * locks were granted. An order's or quote's request id never changes after
 * creation, so callers read it before the transaction to know which request
 * to lock first.
 */

export interface LockedRequest {
  id: bigint;
  status: string;
  branch_id: bigint | null;
  created_by: bigint | null;
  updated_by: bigint | null;
  submitted_by: bigint | null;
  request_date: Date;
}

const big = (v: bigint | number | null) => (v === null ? null : BigInt(v));

export interface LockedRequestLine {
  id: bigint;
  line_no: number;
  item_id: bigint;
  item_unit_id: bigint | null;
  qty: Decimal;
  ordered_qty: Decimal;
}

/** The request row FOR UPDATE (or LOCK IN SHARE MODE with `shared`); NOT_FOUND when absent. */
export async function lockRequest(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  id: bigint,
  shared = false,
): Promise<LockedRequest> {
  const mode = shared ? Prisma.sql`LOCK IN SHARE MODE` : Prisma.sql`FOR UPDATE`;
  const [row] = await tx.$queryRaw<LockedRequest[]>`
    SELECT id, status, branch_id, created_by, updated_by, submitted_by, request_date FROM purchase_requests
     WHERE tenant_id = ${tenantId} AND id = ${id} ${mode}`;
  if (!row) throw DomainError.notFound('PurchaseRequest', id.toString());
  return {
    ...row,
    id: BigInt(row.id),
    branch_id: big(row.branch_id),
    created_by: big(row.created_by),
    updated_by: big(row.updated_by),
    submitted_by: big(row.submitted_by),
  };
}

/** The request's lines FOR UPDATE, in id order, keyed by id. */
export async function lockRequestLines(
  tx: Prisma.TransactionClient,
  tenantId: bigint,
  requestId: bigint,
): Promise<Map<bigint, LockedRequestLine>> {
  const rows = await tx.$queryRaw<
    { id: bigint; line_no: number; item_id: bigint; item_unit_id: bigint | null; qty: { toString(): string }; ordered_qty: { toString(): string } }[]
  >`
    SELECT id, line_no, item_id, item_unit_id, qty, ordered_qty FROM purchase_request_lines
     WHERE tenant_id = ${tenantId} AND request_id = ${requestId}
     ORDER BY id FOR UPDATE`;
  return new Map(
    rows.map((r) => [
      BigInt(r.id),
      {
        id: BigInt(r.id),
        line_no: Number(r.line_no),
        item_id: BigInt(r.item_id),
        item_unit_id: r.item_unit_id === null ? null : BigInt(r.item_unit_id),
        qty: new Decimal(r.qty.toString()),
        ordered_qty: new Decimal(r.ordered_qty.toString()),
      },
    ]),
  );
}

export interface LockedDocument {
  id: bigint;
  status: string;
  branch_id: bigint | null;
  created_by: bigint | null;
  updated_by: bigint | null;
  /** Orders only (quotes have no submission); null on a quote. */
  submitted_by: bigint | null;
  request_id: bigint | null;
}

/** One document row FOR UPDATE: its status, branch, authors and request; NOT_FOUND when absent. */
export async function lockDocument(
  tx: Prisma.TransactionClient,
  table: 'purchase_quotes' | 'purchase_orders',
  tenantId: bigint,
  id: bigint,
): Promise<LockedDocument> {
  const [row] =
    table === 'purchase_quotes'
      ? await tx.$queryRaw<LockedDocument[]>`
          SELECT id, status, branch_id, created_by, updated_by, NULL AS submitted_by, request_id
            FROM purchase_quotes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`
      : await tx.$queryRaw<LockedDocument[]>`
          SELECT id, status, branch_id, created_by, updated_by, submitted_by, request_id
            FROM purchase_orders WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  if (!row) throw DomainError.notFound(table === 'purchase_quotes' ? 'PurchaseQuote' : 'PurchaseOrder', id.toString());
  return {
    id: BigInt(row.id),
    status: row.status,
    branch_id: big(row.branch_id),
    created_by: big(row.created_by),
    updated_by: big(row.updated_by),
    submitted_by: big(row.submitted_by),
    request_id: big(row.request_id),
  };
}

/** INVALID_STATUS_TRANSITION unless `status` is one of `allowed`. */
export function assertStatus(kind: string, status: string, allowed: readonly string[], action: string): void {
  if (!allowed.includes(status)) {
    throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, `A ${status} ${kind} cannot be ${action}`, {
      status,
      action,
      allowed: [...allowed],
    });
  }
}
