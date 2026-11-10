import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, currentBranchId } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { outstandingAmount } from '../shared/invoice-balance.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import type {
  AllocateVoucherDto,
  CreatePaymentDto,
  CreateReceiptDto,
  ReverseVoucherDto,
} from './dto/treasury.dto.js';

type VoucherKind = 'receipt' | 'payment';

/** Adds allocatedAmount / unallocatedAmount (active allocations only). */
function withAllocationTotals<
  T extends { amount: { toString(): string }; allocations: { amount: { toString(): string }; cancelledAt: Date | null }[] },
>(v: T) {
  const allocated = v.allocations
    .filter((a) => a.cancelledAt === null)
    .reduce((s, a) => s.plus(a.amount.toString()), new Decimal(0));
  return {
    ...v,
    allocatedAmount: allocated.toFixed(3),
    unallocatedAmount: new Decimal(v.amount.toString()).minus(allocated).toFixed(3),
  };
}

type AllocationInput = {
  documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE';
  documentId: string;
  amount: string;
};

/**
 * Treasury vouchers (§7.8): receipt (سند قبض) and payment (سند صرف) documents
 * that post a journal entry immediately and optionally allocate the amount
 * to open invoices. Invoice outstanding = grand_total − paid_amount −
 * posted credit returns (§7.8 decision).
 */
@Injectable()
export class VouchersService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------- receipts

  async listReceipts() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.receipt.findMany({
      where: { companyId },
      include: {
        party: { select: { id: true, code: true, nameAr: true, partyType: true } },
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { allocations: true } },
      },
      orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async getReceipt(id: bigint) {
    const { db } = this.support.tenant();
    const r = await db.receipt.findFirst({
      where: { id },
      include: {
        party: true,
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        paymentMethod: { select: { id: true, code: true, nameAr: true } },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        allocations: {
          include: { party: { select: { id: true, code: true, nameAr: true } } },
        },
      },
    });
    if (!r) throw DomainError.notFound('Receipt', id.toString());
    return withAllocationTotals(r);
  }

  async createReceipt(dto: CreateReceiptDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    const amount = new Decimal(dto.amount);
    if (amount.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'amount must be > 0');

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.assertReceiptParty(tx, tenantId, companyId, dto);
        await this.assertCashAccount(tx, companyId, dto.cashAccountId);
        const period = await this.posting.resolveOpenPeriod(
          tx, tenantId, companyId, new Date(dto.receiptDate),
        );

        const receiptNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'RECEIPT', new Date(dto.receiptDate),
        );
        const entryNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'JOURNAL_ENTRY', new Date(dto.receiptDate),
        );

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'CUSTOMERS_CONTROL',
          'SUPPLIERS_CONTROL',
        ]);
        const controlAccount =
          dto.partyType === 'CUSTOMER' ? mapping.CUSTOMERS_CONTROL : mapping.SUPPLIERS_CONTROL;

        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          entryDate: new Date(dto.receiptDate),
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: 'RECEIPT',
          sourceId: null, // set after receipt creation below via second pass? — see note
          voucherType: 'RECEIPT_VOUCHER',
          description: dto.description ?? `Receipt ${receiptNo}`,
          lines: [
            { accountId: BigInt(dto.cashAccountId), debit: amount.toString() },
            {
              accountId: controlAccount,
              credit: amount.toString(),
              partyType: dto.partyType,
              partyId: BigInt(dto.partyId),
            },
          ],
          postedBy: userId ?? null,
        });

        const receipt = await tx.receipt.create({
          data: {
            tenantId,
            companyId,
            branchId: currentBranchId(),
            receiptNo,
            receiptDate: new Date(dto.receiptDate),
            partyType: dto.partyType,
            partyId: BigInt(dto.partyId),
            cashAccountId: BigInt(dto.cashAccountId),
            amount,
            paymentMethodId: dto.paymentMethodId ? BigInt(dto.paymentMethodId) : null,
            referenceNo: dto.referenceNo ?? null,
            description: dto.description ?? null,
            status: 'POSTED',
            journalEntryId: entry.id,
            createdBy: userId ?? null,
          },
        });

        // Link journal entry source to the receipt for traceability.
        await tx.journalEntry.update({
          where: { id: entry.id },
          data: { sourceId: receipt.id },
        });

        await this.applyAllocations(tx, tenantId, companyId, {
          receiptId: receipt.id,
          partyType: dto.partyType,
          partyId: BigInt(dto.partyId),
          amount,
          allocations: dto.allocations ?? [],
          auto: dto.autoAllocate === true,
          userId,
        });

        return { id: receipt.id, receiptNo };
      }),
    );

    await this.audit.log({
      action: 'receipt.create',
      entityType: 'receipt',
      entityId: result.id,
      after: { receiptNo: result.receiptNo },
    });
    return this.getReceipt(result.id);
  }

  // ------------------------------------------------------------- payments

  async listPayments() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    return db.payment.findMany({
      where: { companyId },
      include: {
        party: { select: { id: true, code: true, nameAr: true, partyType: true } },
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        expenseAccount: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { allocations: true } },
      },
      orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
  }

  async getPayment(id: bigint) {
    const { db } = this.support.tenant();
    const p = await db.payment.findFirst({
      where: { id },
      include: {
        party: true,
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        expenseAccount: { select: { id: true, code: true, nameAr: true } },
        paymentMethod: { select: { id: true, code: true, nameAr: true } },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        allocations: {
          include: { party: { select: { id: true, code: true, nameAr: true } } },
        },
      },
    });
    if (!p) throw DomainError.notFound('Payment', id.toString());
    return withAllocationTotals(p);
  }

  async createPayment(dto: CreatePaymentDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();
    const amount = new Decimal(dto.amount);
    if (amount.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'amount must be > 0');
    if (!dto.partyId && !dto.expenseAccountId) {
      throw new DomainError(ErrorCode.VALIDATION, 'partyId or expenseAccountId is required');
    }
    if (dto.partyId && !dto.partyType) {
      throw new DomainError(ErrorCode.VALIDATION, 'partyType is required when partyId is set');
    }

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.assertCashAccount(tx, companyId, dto.cashAccountId);
        if (dto.partyId) {
          await this.assertPaymentParty(tx, tenantId, companyId, dto);
        } else {
          const exp = await tx.account.findFirst({
            where: {
              companyId,
              id: BigInt(dto.expenseAccountId!),
              isActive: true,
              isPostable: true,
            },
            select: { id: true },
          });
          if (!exp) throw DomainError.notFound('Account', dto.expenseAccountId!);
        }
        const period = await this.posting.resolveOpenPeriod(
          tx, tenantId, companyId, new Date(dto.paymentDate),
        );

        const paymentNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'PAYMENT', new Date(dto.paymentDate),
        );
        const entryNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'JOURNAL_ENTRY', new Date(dto.paymentDate),
        );

        const debitLines: JournalLineInput[] = [];
        if (dto.partyId) {
          const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
            'CUSTOMERS_CONTROL',
            'SUPPLIERS_CONTROL',
          ]);
          const controlAccount =
            dto.partyType === 'CUSTOMER' ? mapping.CUSTOMERS_CONTROL : mapping.SUPPLIERS_CONTROL;
          debitLines.push({
            accountId: controlAccount,
            debit: amount.toString(),
            partyType: dto.partyType!,
            partyId: BigInt(dto.partyId),
          });
        } else {
          debitLines.push({
            accountId: BigInt(dto.expenseAccountId!),
            debit: amount.toString(),
          });
        }

        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          entryDate: new Date(dto.paymentDate),
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: 'PAYMENT',
          sourceId: null,
          voucherType: 'PAYMENT_VOUCHER',
          description: dto.description ?? `Payment ${paymentNo}`,
          lines: [
            ...debitLines,
            { accountId: BigInt(dto.cashAccountId), credit: amount.toString() },
          ],
          postedBy: userId ?? null,
        });

        const payment = await tx.payment.create({
          data: {
            tenantId,
            companyId,
            branchId: currentBranchId(),
            paymentNo,
            paymentDate: new Date(dto.paymentDate),
            partyType: dto.partyType ?? null,
            partyId: dto.partyId ? BigInt(dto.partyId) : null,
            expenseAccountId: dto.expenseAccountId ? BigInt(dto.expenseAccountId) : null,
            cashAccountId: BigInt(dto.cashAccountId),
            amount,
            paymentMethodId: dto.paymentMethodId ? BigInt(dto.paymentMethodId) : null,
            referenceNo: dto.referenceNo ?? null,
            description: dto.description ?? null,
            status: 'POSTED',
            journalEntryId: entry.id,
            createdBy: userId ?? null,
          },
        });
        await tx.journalEntry.update({
          where: { id: entry.id },
          data: { sourceId: payment.id },
        });

        if (dto.partyId && dto.partyType) {
          await this.applyAllocations(tx, tenantId, companyId, {
            paymentId: payment.id,
            partyType: dto.partyType,
            partyId: BigInt(dto.partyId),
            amount,
            allocations: dto.allocations ?? [],
            auto: dto.autoAllocate === true,
            userId,
          });
        } else if ((dto.allocations ?? []).length > 0 || dto.autoAllocate) {
          throw new DomainError(ErrorCode.VALIDATION, 'allocations require a party payment');
        }

        return { id: payment.id, paymentNo };
      }),
    );

    await this.audit.log({
      action: 'payment.create',
      entityType: 'payment',
      entityId: result.id,
      after: { paymentNo: result.paymentNo },
    });
    return this.getPayment(result.id);
  }

  // ------------------------------------------- allocate later / cancel / reverse

  /** Allocate what is left of a posted party voucher — manually or oldest-first. */
  async allocateVoucher(kind: VoucherKind, id: bigint, dto: AllocateVoucherDto) {
    if (!dto.auto && !(dto.allocations?.length)) {
      throw new DomainError(ErrorCode.VALIDATION, 'Give allocations or set auto');
    }
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const v = await this.lockVoucher(tx, tenantId, kind, id);
        assertBranchAllowed(v.branchId);
        if (v.reversedAt) throw new DomainError(ErrorCode.CONFLICT, 'The voucher is reversed');
        if (!v.partyId || !v.partyType) {
          throw new DomainError(ErrorCode.VALIDATION, 'Only vouchers with a party can be allocated');
        }
        const left = new Decimal(v.amount.toString()).minus(await this.activeAllocated(tx, kind, id));
        if (left.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'The voucher is fully allocated');
        await this.applyAllocations(tx, tenantId, companyId, {
          ...(kind === 'receipt' ? { receiptId: id } : { paymentId: id }),
          partyType: v.partyType,
          partyId: v.partyId,
          amount: left,
          allocations: dto.allocations ?? [],
          auto: dto.auto === true,
          userId,
        });
      }),
    );
    await this.audit.log({ action: `${kind}.allocate`, entityType: kind, entityId: id });
    return kind === 'receipt' ? this.getReceipt(id) : this.getPayment(id);
  }

  /** Cancel an allocation: the invoice owes that amount again; history is kept. */
  async cancelAllocation(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        // Lock first, so the read below sees the latest state: two cancels of
        // the same allocation must not both decrement paid_amount.
        await tx.$queryRaw`SELECT id FROM allocations WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
        const a = await tx.allocation.findFirst({
          where: { id },
          include: {
            receipt: { select: { id: true, branchId: true } },
            payment: { select: { id: true, branchId: true } },
          },
        });
        if (!a) throw DomainError.notFound('Allocation', id.toString());
        if (a.cancelledAt) throw new DomainError(ErrorCode.CONFLICT, 'Allocation already cancelled');
        assertBranchAllowed(a.receipt?.branchId ?? a.payment?.branchId);
        const documentType = a.documentType as 'SALES_INVOICE' | 'PURCHASE_INVOICE';
        await this.lockInvoice(tx, tenantId, documentType, a.documentId);
        await tx.allocation.update({
          where: { id },
          data: { cancelledAt: new Date(), cancelledBy: userId ?? null },
        });
        // Projection: paid_amount on the invoice (§7.8).
        if (documentType === 'SALES_INVOICE') {
          await tx.salesInvoice.update({
            where: { id: a.documentId },
            data: { paidAmount: { decrement: a.amount } },
          });
        } else {
          await tx.purchaseInvoice.update({
            where: { id: a.documentId },
            data: { paidAmount: { decrement: a.amount } },
          });
        }
        return a.receipt
          ? { kind: 'receipt' as const, id: a.receipt.id }
          : { kind: 'payment' as const, id: a.payment!.id };
      }),
    );
    await this.audit.log({ action: 'allocation.cancel', entityType: 'allocation', entityId: id });
    return result.kind === 'receipt' ? this.getReceipt(result.id) : this.getPayment(result.id);
  }

  /**
   * Reverse a posted voucher (§8.3): a mirror journal entry on the given date.
   * Refused while it still has active allocations — cancel them first
   * (Phase 6 acceptance).
   */
  async reverseVoucher(kind: VoucherKind, id: bigint, dto: ReverseVoucherDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const v = await this.lockVoucher(tx, tenantId, kind, id);
        assertBranchAllowed(v.branchId);
        if (v.reversedAt) throw new DomainError(ErrorCode.CONFLICT, 'The voucher is already reversed');
        if ((await this.activeAllocated(tx, kind, id)).gt(0)) {
          throw new DomainError(
            ErrorCode.VOUCHER_HAS_ALLOCATIONS,
            'Cancel the allocations of this voucher before reversing it',
          );
        }
        if (!v.journalEntryId) throw new DomainError(ErrorCode.CONFLICT, 'The voucher has no journal entry');
        const reversal = await this.posting.reverseEntry(tx, {
          tenantId,
          companyId,
          entryId: v.journalEntryId,
          reversalDate: new Date(dto.reversalDate),
          description: dto.description,
          postedBy: userId ?? null,
        });
        const data = { reversedAt: new Date(), reversedBy: userId ?? null, reversalEntryId: reversal.id };
        if (kind === 'receipt') await tx.receipt.update({ where: { id }, data });
        else await tx.payment.update({ where: { id }, data });
      }),
    );
    await this.audit.log({ action: `${kind}.reverse`, entityType: kind, entityId: id });
    return kind === 'receipt' ? this.getReceipt(id) : this.getPayment(id);
  }

  /** SELECT … FOR UPDATE on the voucher row, then its fields. */
  private async lockVoucher(tx: Prisma.TransactionClient, tenantId: bigint, kind: VoucherKind, id: bigint) {
    const select = {
      amount: true,
      partyType: true,
      partyId: true,
      branchId: true,
      reversedAt: true,
      journalEntryId: true,
    } as const;
    if (kind === 'receipt') {
      await tx.$queryRaw`SELECT id FROM receipts WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      const r = await tx.receipt.findFirst({ where: { id }, select });
      if (!r) throw DomainError.notFound('Receipt', id.toString());
      return r;
    }
    await tx.$queryRaw`SELECT id FROM payments WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    const p = await tx.payment.findFirst({ where: { id }, select });
    if (!p) throw DomainError.notFound('Payment', id.toString());
    return p;
  }

  /** Sum of the voucher's active (not cancelled) allocations. */
  private async activeAllocated(tx: Prisma.TransactionClient, kind: VoucherKind, id: bigint) {
    const agg =
      kind === 'receipt'
        ? await tx.allocation.aggregate({ where: { receiptId: id, cancelledAt: null }, _sum: { amount: true } })
        : await tx.allocation.aggregate({ where: { paymentId: id, cancelledAt: null }, _sum: { amount: true } });
    return new Decimal(agg._sum.amount?.toString() ?? '0');
  }

  // ------------------------------------------------------------ allocations

  private async applyAllocations(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    opts: {
      receiptId?: bigint;
      paymentId?: bigint;
      partyType: 'CUSTOMER' | 'SUPPLIER';
      partyId: bigint;
      /** Most that may be allocated now: the voucher amount, or what is left of it. */
      amount: Decimal;
      allocations: AllocationInput[];
      /** No explicit allocations: settle the party's oldest open invoices first. */
      auto?: boolean;
      userId?: bigint | null;
    },
  ) {
    // Direction check: customers settle sales invoices, suppliers purchase invoices.
    const expectedDoc = opts.partyType === 'CUSTOMER' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';
    let requested = opts.allocations;
    if (requested.length === 0 && opts.auto) {
      requested = await this.oldestFirst(tx, tenantId, companyId, expectedDoc, opts.partyId, opts.amount);
    }
    if (requested.length === 0) return;

    // Lock the invoices (fixed id order) before reading what they still owe:
    // two vouchers allocating the same invoice at once must not both see the
    // old balance (§10.1 step 7).
    const ids = [
      ...new Set(requested.filter((a) => a.documentType === expectedDoc).map((a) => a.documentId)),
    ]
      .map(BigInt)
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const id of ids) await this.lockInvoice(tx, tenantId, expectedDoc, id);

    let allocated = new Decimal(0);
    for (const a of requested) {
      const amt = new Decimal(a.amount);
      if (amt.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'allocation amount must be > 0');
      if (a.documentType !== expectedDoc) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `A ${opts.partyType} voucher can only allocate to ${expectedDoc}`,
        );
      }
      const docId = BigInt(a.documentId);
      const outstanding = await this.invoiceOutstanding(tx, tenantId, a.documentType, docId);
      if (outstanding === null) {
        throw DomainError.notFound(a.documentType, a.documentId);
      }
      const doc =
        a.documentType === 'SALES_INVOICE'
          ? await tx.salesInvoice.findFirst({
              where: { id: docId },
              select: { customerId: true, status: true, paymentType: true },
            })
          : await tx.purchaseInvoice.findFirst({
              where: { id: docId },
              select: { supplierId: true, status: true, paymentType: true },
            });
      const docParty =
        a.documentType === 'SALES_INVOICE'
          ? (doc as { customerId?: bigint } | null)?.customerId
          : (doc as { supplierId?: bigint } | null)?.supplierId;
      if (!doc || doc.status !== 'POSTED' || docParty !== opts.partyId) {
        throw new DomainError(ErrorCode.VALIDATION, 'Invoice not found, not posted, or belongs to another party');
      }
      // Cash invoices are settled at sale (Dr cash); a voucher on one would
      // record the same money twice.
      if (doc.paymentType === 'CASH') {
        throw new DomainError(ErrorCode.VALIDATION, 'Cash invoices are paid at sale and cannot take allocations');
      }
      allocated = allocated.plus(amt);
      if (allocated.gt(opts.amount)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Total allocations exceed voucher amount');
      }
      // `outstanding` is fresh per iteration — paid_amount increments below
      // are visible to the next lookup within this transaction.
      if (amt.gt(outstanding)) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Allocation ${amt.toString()} exceeds invoice outstanding ${outstanding.toString()}`,
        );
      }

      await tx.allocation.create({
        data: {
          tenantId,
          companyId,
          receiptId: opts.receiptId ?? null,
          paymentId: opts.paymentId ?? null,
          partyType: opts.partyType,
          partyId: opts.partyId,
          documentType: a.documentType,
          documentId: docId,
          amount: amt,
          createdBy: opts.userId ?? null,
        },
      });

      // Projection: paid_amount on the invoice (§7.8).
      if (a.documentType === 'SALES_INVOICE') {
        await tx.salesInvoice.update({
          where: { id: docId },
          data: { paidAmount: { increment: amt } },
        });
      } else {
        await tx.purchaseInvoice.update({
          where: { id: docId },
          data: { paidAmount: { increment: amt } },
        });
      }
    }
  }

  /** SELECT … FOR UPDATE on an invoice row (tenant-scoped raw query). */
  private async lockInvoice(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    id: bigint,
  ) {
    if (documentType === 'SALES_INVOICE') {
      await tx.$queryRaw`SELECT id FROM sales_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT id FROM purchase_invoices WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
    }
  }

  /**
   * Auto-allocation (Phase 6): the party's posted credit invoices, oldest
   * first, each up to what it still owes, until `available` is used up.
   * Cash invoices are settled at sale and never take allocations.
   */
  private async oldestFirst(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    partyId: bigint,
    available: Decimal,
  ): Promise<AllocationInput[]> {
    const where = { companyId, status: 'POSTED' as const, paymentType: 'CREDIT' as const };
    const orderBy = [{ invoiceDate: 'asc' as const }, { id: 'asc' as const }];
    const invoices =
      documentType === 'SALES_INVOICE'
        ? await tx.salesInvoice.findMany({ where: { ...where, customerId: partyId }, select: { id: true }, orderBy })
        : await tx.purchaseInvoice.findMany({ where: { ...where, supplierId: partyId }, select: { id: true }, orderBy });

    const result: AllocationInput[] = [];
    let left = available;
    for (const inv of invoices) {
      if (left.lte(0)) break;
      await this.lockInvoice(tx, tenantId, documentType, inv.id);
      const owed = await this.invoiceOutstanding(tx, tenantId, documentType, inv.id);
      if (!owed || owed.lte(0)) continue;
      const amount = Decimal.min(owed, left);
      result.push({ documentType, documentId: inv.id.toString(), amount: amount.toFixed(3) });
      left = left.minus(amount);
    }
    return result;
  }

  /**
   * outstanding = grand_total − paid_amount − posted credit-return totals,
   * read with LOCKING reads. Under REPEATABLE READ a plain SELECT returns the
   * transaction's snapshot, taken before it waited for the invoice lock — so
   * a voucher racing another would still see the old paid_amount and settle
   * the invoice twice (caught by the phase 6 race test). FOR UPDATE / LOCK IN
   * SHARE MODE always read the latest committed rows.
   */
  private async invoiceOutstanding(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    documentId: bigint,
  ): Promise<Decimal | null> {
    type Totals = { grand_total: { toString(): string }; paid_amount: { toString(): string } };
    type Sum = { s: { toString(): string } | null };
    const [inv] =
      documentType === 'SALES_INVOICE'
        ? await tx.$queryRaw<Totals[]>`
            SELECT grand_total, paid_amount FROM sales_invoices
             WHERE tenant_id = ${tenantId} AND id = ${documentId} FOR UPDATE`
        : await tx.$queryRaw<Totals[]>`
            SELECT grand_total, paid_amount FROM purchase_invoices
             WHERE tenant_id = ${tenantId} AND id = ${documentId} FOR UPDATE`;
    if (!inv) return null;
    const [returns] =
      documentType === 'SALES_INVOICE'
        ? await tx.$queryRaw<Sum[]>`
            SELECT SUM(grand_total) AS s FROM sales_returns
             WHERE tenant_id = ${tenantId} AND original_invoice_id = ${documentId}
               AND status = 'POSTED' AND refund_type = 'CREDIT' LOCK IN SHARE MODE`
        : await tx.$queryRaw<Sum[]>`
            SELECT SUM(grand_total) AS s FROM purchase_returns
             WHERE tenant_id = ${tenantId} AND original_invoice_id = ${documentId}
               AND status = 'POSTED' AND refund_type = 'CREDIT' LOCK IN SHARE MODE`;
    return outstandingAmount(inv.grand_total, inv.paid_amount, returns?.s ?? 0);
  }

  // -------------------------------------------------------------- helpers

  private async assertReceiptParty(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    dto: CreateReceiptDto,
  ) {
    const party = await tx.party.findFirst({
      where: { tenantId, companyId, id: BigInt(dto.partyId), isActive: true },
      select: { id: true, partyType: true },
    });
    const ok =
      party &&
      ((dto.partyType === 'CUSTOMER' && (party.partyType === 'CUSTOMER' || party.partyType === 'BOTH')) ||
        (dto.partyType === 'SUPPLIER' && (party.partyType === 'SUPPLIER' || party.partyType === 'BOTH')));
    if (!ok) {
      throw new DomainError(ErrorCode.VALIDATION, 'Party not found or type mismatch');
    }
  }

  private async assertPaymentParty(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    dto: CreatePaymentDto,
  ) {
    const party = await tx.party.findFirst({
      where: { tenantId, companyId, id: BigInt(dto.partyId!), isActive: true },
      select: { id: true, partyType: true },
    });
    const ok =
      party &&
      ((dto.partyType === 'CUSTOMER' && (party.partyType === 'CUSTOMER' || party.partyType === 'BOTH')) ||
        (dto.partyType === 'SUPPLIER' && (party.partyType === 'SUPPLIER' || party.partyType === 'BOTH')));
    if (!ok) {
      throw new DomainError(ErrorCode.VALIDATION, 'Party not found or type mismatch');
    }
  }

  private async assertCashAccount(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    accountId: string,
  ) {
    const acc = await tx.account.findFirst({
      where: {
        companyId,
        id: BigInt(accountId),
        isActive: true,
        isPostable: true,
        controlType: { in: ['CASH', 'BANK'] },
      },
      select: { id: true },
    });
    if (!acc) {
      throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId must be an active cash/bank account');
    }
  }
}
