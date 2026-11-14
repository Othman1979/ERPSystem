import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, currentBranchId } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type { InvoiceSettlement } from '../shared/invoice-settlement.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { PurchaseInvoicesService } from '../purchases/purchase-invoices.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import type {
  AllocateVoucherDto,
  CreatePaymentDto,
  CreateReceiptDto,
  ReverseVoucherDto,
} from './dto/treasury.dto.js';
import { PartyUsageRegistry } from '../parties/party-usage.registry.js';

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

type InvoiceDocType = 'SALES_INVOICE' | 'PURCHASE_INVOICE';

type AllocationInput = {
  documentType: InvoiceDocType;
  documentId: string;
  amount: string;
};

/** An allocation checked against its locked invoice, written once the voucher exists. */
type PlannedAllocation = {
  documentType: InvoiceDocType;
  documentId: bigint;
  amount: Decimal;
};

/** Whether the current member may work on `branchId` (ADR-003). */
function branchAllowed(branchId: bigint | null): boolean {
  try {
    assertBranchAllowed(branchId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Treasury vouchers (§7.8): receipt (سند قبض) and payment (سند صرف) documents
 * that post a journal entry immediately and optionally allocate the amount
 * to open invoices. Invoice outstanding = grand_total − paid_amount −
 * posted credit returns (§7.8 decision). Invoices are locked, read and
 * updated only through the invoice services (module boundary, ADR-004).
 */
@Injectable()
export class VouchersService implements OnModuleInit {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly sales: SalesInvoicesService,
    private readonly purchases: PurchaseInvoicesService,
    private readonly partyUsage: PartyUsageRegistry,
  ) {}

  onModuleInit(): void {
    this.partyUsage.register('treasury', (tx, partyId) => this.partyInUse(tx, partyId));
  }

  /**
   * DB-15 / ADR-021: the first treasury table that references the party in
   * any status (drafts included), or null, read on the caller's transaction.
   * A party used here is deactivated, never deleted.
   */
  async partyInUse(tx: Prisma.TransactionClient, partyId: bigint): Promise<string | null> {
    if (await tx.receipt.findFirst({ where: { partyId }, select: { id: true } })) return 'receipts';
    if (await tx.payment.findFirst({ where: { partyId }, select: { id: true } })) return 'payments';
    if (await tx.allocation.findFirst({ where: { partyId }, select: { id: true } })) return 'allocations';
    return null;
  }

  /** The invoice service that owns the given document type. */
  private settlement(documentType: InvoiceDocType): InvoiceSettlement {
    return documentType === 'SALES_INVOICE' ? this.sales : this.purchases;
  }

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
    const branchId = currentBranchId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        await this.assertReceiptParty(tx, tenantId, companyId, dto);
        await this.assertCashAccount(tx, companyId, dto.cashAccountId);
        const period = await this.posting.resolveOpenPeriod(
          tx, tenantId, companyId, new Date(dto.receiptDate),
        );
        // TRADE-17: lock and check the invoices before taking the document
        // numbers, the order invoice posting follows (invoice, then sequences).
        const plan = await this.planAllocations(tx, companyId, {
          receipt: true,
          partyType: dto.partyType,
          partyId: BigInt(dto.partyId),
          amount,
          allocations: dto.allocations ?? [],
          auto: dto.autoAllocate === true,
        });

        const receiptNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'RECEIPT', new Date(dto.receiptDate),
        );
        // The voucher row first, so the entry is posted with its source (no
        // update of a posted journal entry afterwards).
        const receipt = await tx.receipt.create({
          data: {
            tenantId,
            companyId,
            branchId,
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
            createdBy: userId ?? null,
          },
        });
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
          sourceType: 'RECEIPT',
          sourceId: receipt.id,
          branchId, // ADR-003: the entry carries its voucher's branch
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

        await tx.receipt.update({ where: { id: receipt.id }, data: { journalEntryId: entry.id } });

        await this.writeAllocations(tx, tenantId, companyId, plan, {
          receiptId: receipt.id,
          partyType: dto.partyType,
          partyId: BigInt(dto.partyId),
          userId,
        });

        return { id: receipt.id, receiptNo };
      }, POSTING_TX_OPTIONS),
    );

    await this.audit.log({
      action: 'receipt.create',
      entityType: 'receipt',
      entityId: result.id,
      after: { receiptNo: result.receiptNo },
    });
    return this.getReceipt(result.id);
  }

  /** A voucher for printing: the invoices its active allocations settle, by number. */
  async printable(kind: VoucherKind, id: bigint) {
    const v = kind === 'receipt' ? await this.getReceipt(id) : await this.getPayment(id);
    const active = v.allocations.filter((a) => a.cancelledAt === null);
    const sales = await this.sales.invoiceNumbers(active.filter((a) => a.documentType === 'SALES_INVOICE').map((a) => a.documentId));
    const purchases = await this.purchases.invoiceNumbers(
      active.filter((a) => a.documentType === 'PURCHASE_INVOICE').map((a) => a.documentId),
    );
    return {
      ...v,
      allocations: v.allocations.map((a) => ({
        ...a,
        invoiceNo: (a.documentType === 'SALES_INVOICE' ? sales : purchases).get(a.documentId) ?? null,
      })),
    };
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
    const branchId = currentBranchId();

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
        // TRADE-17: lock and check the invoices before taking the document numbers.
        let plan: PlannedAllocation[] = [];
        if (dto.partyId && dto.partyType) {
          plan = await this.planAllocations(tx, companyId, {
            receipt: false,
            partyType: dto.partyType,
            partyId: BigInt(dto.partyId),
            amount,
            allocations: dto.allocations ?? [],
            auto: dto.autoAllocate === true,
          });
        } else if ((dto.allocations ?? []).length > 0 || dto.autoAllocate) {
          throw new DomainError(ErrorCode.VALIDATION, 'allocations require a party payment');
        }

        const paymentNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'PAYMENT', new Date(dto.paymentDate),
        );
        // The voucher row first, so the entry is posted with its source.
        const payment = await tx.payment.create({
          data: {
            tenantId,
            companyId,
            branchId,
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
            createdBy: userId ?? null,
          },
        });
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
          sourceType: 'PAYMENT',
          sourceId: payment.id,
          branchId, // ADR-003: the entry carries its voucher's branch
          voucherType: 'PAYMENT_VOUCHER',
          description: dto.description ?? `Payment ${paymentNo}`,
          lines: [
            ...debitLines,
            { accountId: BigInt(dto.cashAccountId), credit: amount.toString() },
          ],
          postedBy: userId ?? null,
        });

        await tx.payment.update({ where: { id: payment.id }, data: { journalEntryId: entry.id } });

        if (dto.partyId && dto.partyType) {
          await this.writeAllocations(tx, tenantId, companyId, plan, {
            paymentId: payment.id,
            partyType: dto.partyType,
            partyId: BigInt(dto.partyId),
            userId,
          });
        }

        return { id: payment.id, paymentNo };
      }, POSTING_TX_OPTIONS),
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
        const plan = await this.planAllocations(tx, companyId, {
          receipt: kind === 'receipt',
          partyType: v.partyType,
          partyId: v.partyId,
          amount: left,
          allocations: dto.allocations ?? [],
          auto: dto.auto === true,
        });
        await this.writeAllocations(tx, tenantId, companyId, plan, {
          ...(kind === 'receipt' ? { receiptId: id } : { paymentId: id }),
          partyType: v.partyType,
          partyId: v.partyId,
          userId,
        });
      }, POSTING_TX_OPTIONS),
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
        const invoices = this.settlement(a.documentType as InvoiceDocType);
        await invoices.lockForSettlement(tx, [a.documentId]);
        // The invoice's branch too: a branch-restricted user does not reopen another branch's invoice (TRADE-11).
        assertBranchAllowed((await invoices.settlementState(tx, a.documentId))?.branchId);
        await tx.allocation.update({
          where: { id },
          data: { cancelledAt: new Date(), cancelledBy: userId ?? null },
        });
        // Projection: paid_amount on the invoice (§7.8).
        await invoices.addPaid(tx, a.documentId, new Decimal(a.amount.toString()).neg());
        return a.receipt
          ? { kind: 'receipt' as const, id: a.receipt.id }
          : { kind: 'payment' as const, id: a.payment!.id };
      }, POSTING_TX_OPTIONS),
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
      }, POSTING_TX_OPTIONS),
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

  /**
   * Checks a voucher's allocations and locks their invoices, before the
   * voucher takes its numbers (TRADE-17): a receipt from a customer or a
   * payment to a supplier only (ADR-004 §3), credit invoices of that party,
   * each within what it still owes, all within `amount`, and in the
   * invoice's branch for a branch-restricted user (ADR-003, TRADE-11).
   * Auto-allocation settles the oldest open invoices first.
   */
  private async planAllocations(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    opts: {
      receipt: boolean;
      partyType: 'CUSTOMER' | 'SUPPLIER';
      partyId: bigint;
      /** Most that may be allocated now: the voucher amount, or what is left of it. */
      amount: Decimal;
      allocations: AllocationInput[];
      /** No explicit allocations: settle the party's oldest open invoices first. */
      auto?: boolean;
    },
  ): Promise<PlannedAllocation[]> {
    if (opts.allocations.length === 0 && !opts.auto) return [];
    // Only a receipt from a customer or a payment to a supplier settles
    // invoices. A refund the other way (receipt from a supplier, payment to
    // a customer) raises the party's balance, so it cannot lower what an
    // invoice owes (ADR-004 §3).
    const settles = opts.receipt ? 'CUSTOMER' : 'SUPPLIER';
    if (opts.partyType !== settles) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        opts.receipt
          ? 'A receipt from a supplier is a refund and cannot be allocated to invoices'
          : 'A payment to a customer is a refund and cannot be allocated to invoices',
      );
    }
    // Direction check: customers settle sales invoices, suppliers purchase invoices.
    const expectedDoc: InvoiceDocType = opts.partyType === 'CUSTOMER' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';
    const invoices = this.settlement(expectedDoc);
    if (opts.allocations.length === 0) {
      return this.oldestFirst(tx, companyId, expectedDoc, opts.partyId, opts.amount);
    }
    const requested = opts.allocations;

    // Lock the invoices (fixed id order) before reading what they still owe:
    // two vouchers allocating the same invoice at once must not both see the
    // old balance (§10.1 step 7).
    await invoices.lockForSettlement(
      tx,
      requested.filter((a) => a.documentType === expectedDoc).map((a) => BigInt(a.documentId)),
    );

    const planned: PlannedAllocation[] = [];
    const plannedOn = new Map<bigint, Decimal>();
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
      const inv = await invoices.settlementState(tx, docId);
      if (inv === null) {
        throw DomainError.notFound(a.documentType, a.documentId);
      }
      if (inv.status !== 'POSTED' || inv.partyId !== opts.partyId) {
        throw new DomainError(ErrorCode.VALIDATION, 'Invoice not found, not posted, or belongs to another party');
      }
      assertBranchAllowed(inv.branchId);
      if (inv.paymentType !== 'CREDIT') {
        throw new DomainError(ErrorCode.VALIDATION, 'A cash invoice is settled at sale and takes no allocations');
      }
      allocated = allocated.plus(amt);
      if (allocated.gt(opts.amount)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Total allocations exceed voucher amount');
      }
      // The same invoice twice in one request: the second sees the first.
      const outstanding = inv.outstanding.minus(plannedOn.get(docId) ?? 0);
      if (amt.gt(outstanding)) {
        throw new DomainError(
          ErrorCode.VALIDATION,
          `Allocation ${amt.toString()} exceeds invoice outstanding ${outstanding.toString()}`,
        );
      }
      plannedOn.set(docId, (plannedOn.get(docId) ?? new Decimal(0)).plus(amt));
      planned.push({ documentType: expectedDoc, documentId: docId, amount: amt });
    }
    return planned;
  }

  /** Writes planned allocations of a voucher and the invoices' paid_amount projection (§7.8). */
  private async writeAllocations(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    plan: PlannedAllocation[],
    opts: {
      receiptId?: bigint;
      paymentId?: bigint;
      partyType: 'CUSTOMER' | 'SUPPLIER';
      partyId: bigint;
      userId?: bigint | null;
    },
  ) {
    for (const p of plan) {
      await tx.allocation.create({
        data: {
          tenantId,
          companyId,
          receiptId: opts.receiptId ?? null,
          paymentId: opts.paymentId ?? null,
          partyType: opts.partyType,
          partyId: opts.partyId,
          documentType: p.documentType,
          documentId: p.documentId,
          amount: p.amount,
          createdBy: opts.userId ?? null,
        },
      });
      await this.settlement(p.documentType).addPaid(tx, p.documentId, p.amount);
    }
  }

  /**
   * Auto-allocation (Phase 6): the party's posted credit invoices with an
   * open balance, oldest first, each up to what it still owes, until
   * `available` is used up. TRADE-18: the open invoices are found in one
   * query and locked in one query in id order (the order a manual
   * allocation locks in, so the two cannot deadlock), then re-read under
   * the lock. Invoices of a branch the user may not use are skipped.
   */
  private async oldestFirst(
    tx: Prisma.TransactionClient,
    companyId: bigint,
    documentType: InvoiceDocType,
    partyId: bigint,
    available: Decimal,
  ): Promise<PlannedAllocation[]> {
    const invoices = this.settlement(documentType);
    const ids = await invoices.creditInvoiceIdsOldestFirst(tx, companyId, partyId);
    await invoices.lockForSettlement(tx, ids);

    const result: PlannedAllocation[] = [];
    let left = available;
    for (const id of ids) {
      if (left.lte(0)) break;
      const inv = await invoices.settlementState(tx, id);
      if (!inv || inv.status !== 'POSTED' || inv.outstanding.lte(0)) continue;
      if (!branchAllowed(inv.branchId)) continue;
      const amount = Decimal.min(inv.outstanding, left);
      result.push({ documentType, documentId: id, amount });
      left = left.minus(amount);
    }
    return result;
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
