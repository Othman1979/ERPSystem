import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { outstandingAmount } from '../shared/invoice-balance.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import type { CreatePaymentDto, CreateReceiptDto } from './dto/treasury.dto.js';

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
    return r;
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
    return p;
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
          });
        } else if ((dto.allocations ?? []).length > 0) {
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
      amount: Decimal;
      allocations: { documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE'; documentId: string; amount: string }[];
    },
  ) {
    if (opts.allocations.length === 0) return;

    // Direction check: customers settle sales invoices, suppliers purchase invoices.
    const expectedDoc = opts.partyType === 'CUSTOMER' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';
    let allocated = new Decimal(0);
    for (const a of opts.allocations) {
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
              select: { customerId: true, status: true },
            })
          : await tx.purchaseInvoice.findFirst({
              where: { id: docId },
              select: { supplierId: true, status: true },
            });
      const docParty =
        a.documentType === 'SALES_INVOICE'
          ? (doc as { customerId?: bigint } | null)?.customerId
          : (doc as { supplierId?: bigint } | null)?.supplierId;
      if (!doc || doc.status !== 'POSTED' || docParty !== opts.partyId) {
        throw new DomainError(ErrorCode.VALIDATION, 'Invoice not found, not posted, or belongs to another party');
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

  /** outstanding = grand_total − paid_amount − posted credit-return totals. */
  private async invoiceOutstanding(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    documentType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    documentId: bigint,
  ): Promise<Decimal | null> {
    if (documentType === 'SALES_INVOICE') {
      const inv = await tx.salesInvoice.findFirst({
        where: { id: documentId },
        select: { grandTotal: true, paidAmount: true, status: true },
      });
      if (!inv) return null;
      const creditReturns = await tx.salesReturn.aggregate({
        where: {
          tenantId,
          originalInvoiceId: documentId,
          status: 'POSTED',
          refundType: 'CREDIT',
        },
        _sum: { grandTotal: true },
      });
      return outstandingAmount(inv.grandTotal, inv.paidAmount, creditReturns._sum.grandTotal ?? 0);
    }
    const inv = await tx.purchaseInvoice.findFirst({
      where: { id: documentId },
      select: { grandTotal: true, paidAmount: true, status: true },
    });
    if (!inv) return null;
    const creditReturns = await tx.purchaseReturn.aggregate({
      where: {
        tenantId,
        originalInvoiceId: documentId,
        status: 'POSTED',
        refundType: 'CREDIT',
      },
      _sum: { grandTotal: true },
    });
    return outstandingAmount(inv.grandTotal, inv.paidAmount, creditReturns._sum.grandTotal ?? 0);
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
