import { Injectable } from '@nestjs/common';
import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import { assertBranchAllowed, currentBranchId } from '../../common/branch/branch-context.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { computeLineAmounts } from '../shared/invoice-math.js';
import { creditedByInvoice, withBalance } from '../shared/invoice-balance.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreateSalesInvoiceDto, SalesInvoiceLineDto } from './dto/sales.dto.js';

const SOURCE = 'SALES_INVOICE';

interface ResolvedLine {
  dto: SalesInvoiceLineDto;
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  itemKind: 'STOCK' | 'SERVICE';
  taxRate: Decimal;
  taxCategoryId: bigint | null;
  amounts: ReturnType<typeof computeLineAmounts>;
}

/** Sales invoices: draft CRUD + post → stock OUT + COGS/revenue journal (§8.4). */
@Injectable()
export class SalesInvoicesService {
  constructor(
    private readonly support: DocumentSupportService,
    private readonly posting: PostingService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
  ) {}

  /** Posted credit-return totals for the given invoices (for `outstanding`). */
  private async creditedFor(
    db: ReturnType<DocumentSupportService['tenant']>['db'],
    invoiceIds: bigint[],
  ) {
    if (invoiceIds.length === 0) return new Map<string, Decimal>();
    const returns = await db.salesReturn.findMany({
      where: { originalInvoiceId: { in: invoiceIds }, status: 'POSTED', refundType: 'CREDIT' },
      select: { originalInvoiceId: true, grandTotal: true },
    });
    return creditedByInvoice(returns);
  }

  /**
   * Posted credit invoices that still owe something (Phase 6 aging): what
   * remains after allocations and credit returns. Cash invoices are settled
   * at sale and never appear.
   */
  async openCreditInvoices() {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const rows = await db.salesInvoice.findMany({
      where: { companyId, status: 'POSTED', paymentType: 'CREDIT' },
      select: {
        id: true,
        invoiceNo: true,
        invoiceDate: true,
        dueDate: true,
        grandTotal: true,
        paidAmount: true,
        customer: { select: { id: true, code: true, nameAr: true, nameEn: true } },
      },
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
    });
    const credited = await this.creditedFor(db, rows.map((r) => r.id));
    return rows
      .map((r) => withBalance(r, credited))
      .filter((r) => new Decimal(r.outstanding).gt(0))
      .map(({ customer: party, ...r }) => ({ ...r, party }));
  }

  async list(status?: string, paymentType?: string, customerId?: string) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const rows = await db.salesInvoice.findMany({
      where: {
        companyId,
        ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}),
        ...(paymentType ? { paymentType: paymentType as 'CASH' | 'CREDIT' } : {}),
        ...(customerId ? { customerId: BigInt(customerId) } : {}),
      },
      include: {
        customer: { select: { id: true, code: true, nameAr: true } },
        warehouse: { select: { id: true, code: true, nameAr: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
      take: 300,
    });
    const credited = await this.creditedFor(db, rows.map((r) => r.id));
    return rows.map((r) => withBalance(r, credited));
  }

  async get(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.salesInvoice.findFirst({
      where: { id },
      include: {
        customer: true,
        warehouse: true,
        cashAccount: { select: { id: true, code: true, nameAr: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            item: { select: { id: true, code: true, nameAr: true, baseUnitId: true, itemKind: true } },
            itemUnit: { include: { unit: { select: { id: true, code: true, nameAr: true } } } },
          },
        },
        journalEntry: { select: { id: true, entryNo: true, status: true } },
        returns: { select: { id: true, returnNo: true, status: true, grandTotal: true } },
      },
    });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    return withBalance(inv, await this.creditedFor(db, [inv.id]));
  }

  async create(dto: CreateSalesInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines);
    await this.assertHeader(db, companyId, dto);

    const inv = await db.$transaction(async (tx) => {
      const created = await tx.salesInvoice.create({
        data: {
          tenantId,
          companyId,
          // Branch from the request context (BranchGuard), never the body — ADR-003.
          branchId: currentBranchId(),
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          customerId: BigInt(dto.customerId),
          warehouseId: BigInt(dto.warehouseId),
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          description: dto.description ?? null,
          ...this.totals(lines),
          createdBy: this.support.userId() ?? null,
        },
      });
      await tx.salesInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: created.id,
          lineNo: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitPrice: l.dto.unitPrice,
          discountPct: l.dto.discountPct ?? '0',
          discountAmount: l.amounts.discountAmount,
          netAmount: l.amounts.netAmount,
          taxCategoryId: l.taxCategoryId,
          taxRate: l.taxRate,
          taxAmount: l.amounts.taxAmount,
          lineTotal: l.amounts.lineTotal,
        })),
      });
      return created;
    });
    await this.audit.log({
      action: 'sales_invoice.create',
      entityType: 'sales_invoice',
      entityId: inv.id,
      after: { lines: lines.length },
    });
    return this.get(inv.id);
  }

  async update(id: bigint, dto: CreateSalesInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const inv = await db.salesInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
    }
    assertBranchAllowed(inv.branchId);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines);
    await this.assertHeader(db, companyId, dto);

    await db.$transaction(async (tx) => {
      await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.salesInvoice.update({
        where: { id },
        data: {
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          customerId: BigInt(dto.customerId),
          warehouseId: BigInt(dto.warehouseId),
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          description: dto.description ?? null,
          ...this.totals(lines),
          updatedBy: this.support.userId() ?? null,
        },
      });
      await tx.salesInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: id,
          lineNo: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitPrice: l.dto.unitPrice,
          discountPct: l.dto.discountPct ?? '0',
          discountAmount: l.amounts.discountAmount,
          netAmount: l.amounts.netAmount,
          taxCategoryId: l.taxCategoryId,
          taxRate: l.taxRate,
          taxAmount: l.amounts.taxAmount,
          lineTotal: l.amounts.lineTotal,
        })),
      });
    });
    await this.audit.log({
      action: 'sales_invoice.update',
      entityType: 'sales_invoice',
      entityId: id,
    });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.salesInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('SalesInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be deleted');
    }
    assertBranchAllowed(inv.branchId);
    await db.salesInvoice.delete({ where: { id } });
    return { deleted: true };
  }

  /** Posts: stock OUT per line + revenue/tax/COGS journal (§8.4, §9). */
  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const draft = await tx.salesInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('SalesInvoice', id.toString());
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Invoice is not a draft');
        }
        assertBranchAllowed(draft.branchId);
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Invoice has no lines');
        }
        if (draft.paymentType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
        }

        const invoiceDate = new Date(draft.invoiceDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, invoiceDate);

        // Stock OUT for STOCK items — returns avg cost per base unit.
        let costTotal = new Decimal(0);
        const costByLine = new Map<bigint, { unitCost: Decimal; totalCost: Decimal }>();
        for (const line of draft.lines) {
          const item = await tx.item.findFirst({
            where: { tenantId, id: line.itemId },
            select: { itemKind: true },
          });
          if (!item) throw DomainError.notFound('Item', line.itemId.toString());
          if (item.itemKind !== 'STOCK') continue;
          const res = await this.ledger.applyMovement(tx, companyId, {
            warehouseId: draft.warehouseId,
            itemId: line.itemId,
            movementDate: invoiceDate,
            type: 'OUT',
            qty: line.qtyBase.toString(),
            sourceType: SOURCE,
            sourceId: draft.id,
            sourceLineId: line.id,
            description: `Sales invoice ${draft.id}`,
          });
          costByLine.set(line.id, { unitCost: res.unitCost, totalCost: res.totalCost });
          costTotal = costTotal.plus(res.totalCost);
        }
        // Persist per-line cost snapshot.
        for (const [lineId, c] of costByLine) {
          await tx.salesInvoiceLine.update({
            where: { id: lineId },
            data: { unitCost: c.unitCost, costTotal: c.totalCost },
          });
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'SALES',
          'OUTPUT_TAX',
          'COGS',
          'INVENTORY',
          'CUSTOMERS_CONTROL',
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const net = draft.netTotal;
        const tax = draft.taxTotal;

        if (draft.paymentType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            debit: grand.toString(),
            description: 'Cash sale',
          });
        } else {
          journalLines.push({
            accountId: mapping.CUSTOMERS_CONTROL,
            debit: grand.toString(),
            partyType: 'CUSTOMER',
            partyId: draft.customerId,
            description: 'Credit sale',
          });
        }
        if (net.gt(0)) {
          journalLines.push({ accountId: mapping.SALES, credit: net.toString() });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.OUTPUT_TAX, credit: tax.toString() });
        }
        if (costTotal.gt(0)) {
          journalLines.push({ accountId: mapping.COGS, debit: costTotal.toString() });
          journalLines.push({ accountId: mapping.INVENTORY, credit: costTotal.toString() });
        }

        const invoiceNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'SALES_INVOICE', invoiceDate,
        );
        const entryNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'JOURNAL_ENTRY', invoiceDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          branchId: draft.branchId,
          entryDate: invoiceDate,
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.description ?? `Sales invoice ${invoiceNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
        });

        await tx.salesInvoice.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            invoiceNo,
            costTotal,
            journalEntryId: entry.id,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id: draft.id, invoiceNo };
      }),
    );

    await this.audit.log({
      action: 'sales_invoice.post',
      entityType: 'sales_invoice',
      entityId: result.id,
      after: { invoiceNo: result.invoiceNo },
    });
    return this.get(result.id);
  }

  // ------------------------------------------------------------- internals

  private totals(lines: ResolvedLine[]) {
    return {
      netTotal: sum(lines.map((l) => l.amounts.netAmount)),
      taxTotal: sum(lines.map((l) => l.amounts.taxAmount)),
      grandTotal: sum(lines.map((l) => l.amounts.lineTotal)),
    };
  }

  private async assertHeader(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    dto: CreateSalesInvoiceDto,
  ) {
    const customer = await db.party.findFirst({
      where: { companyId, id: BigInt(dto.customerId), isActive: true },
      select: { id: true, partyType: true },
    });
    if (!customer || (customer.partyType !== 'CUSTOMER' && customer.partyType !== 'BOTH')) {
      throw new DomainError(ErrorCode.VALIDATION, 'Customer not found or not a customer');
    }
    const warehouse = await db.warehouse.findFirst({
      where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
      select: { id: true },
    });
    if (!warehouse) throw DomainError.notFound('Warehouse', dto.warehouseId);
    if (dto.paymentType === 'CASH') {
      if (!dto.cashAccountId) {
        throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
      }
      const acc = await db.account.findFirst({
        where: {
          companyId,
          id: BigInt(dto.cashAccountId),
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

  private async resolveLines(
    db: ReturnType<PrismaService['forTenant']>,
    tenantId: bigint,
    companyId: bigint,
    dtos: SalesInvoiceLineDto[],
  ): Promise<ResolvedLine[]> {
    const itemIds = dtos.map((l) => BigInt(l.itemId));
    const items = await db.item.findMany({
      where: { tenantId, companyId, id: { in: itemIds }, isActive: true },
      include: { taxCategory: { select: { id: true, rate: true } } },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const unitIds = dtos.filter((l) => l.itemUnitId).map((l) => BigInt(l.itemUnitId!));
    const units = unitIds.length
      ? await db.itemUnit.findMany({
          where: { tenantId, id: { in: unitIds }, isActive: true },
          include: { unit: { select: { id: true, code: true } } },
        })
      : [];
    const unitById = new Map(units.map((u) => [u.id, u]));

    const taxIds = [
      ...new Set(
        dtos
          .map((l) => l.taxCategoryId ?? itemById.get(BigInt(l.itemId))?.taxCategoryId?.toString())
          .filter((x): x is string => !!x)
          .map((x) => BigInt(x)),
      ),
    ];
    const taxes = taxIds.length
      ? await db.taxCategory.findMany({
          where: { tenantId, id: { in: taxIds }, isActive: true },
          select: { id: true, rate: true },
        })
      : [];
    const taxById = new Map(taxes.map((t) => [t.id, t]));
    const defaultTax = await db.taxCategory.findFirst({
      where: { tenantId, isDefault: true, isActive: true },
      select: { id: true, rate: true },
    });

    const out: ResolvedLine[] = [];
    for (const l of dtos) {
      const item = itemById.get(BigInt(l.itemId));
      if (!item) throw DomainError.notFound('Item', l.itemId);

      let itemUnitId: bigint | null = null;
      let factorToBase = new Decimal(1);
      if (l.itemUnitId) {
        const iu = unitById.get(BigInt(l.itemUnitId));
        if (!iu || iu.itemId !== item.id) {
          throw new DomainError(ErrorCode.VALIDATION, `Item unit ${l.itemUnitId} does not belong to item ${item.code}`);
        }
        itemUnitId = iu.id;
        factorToBase = iu.factorToBase;
      }

      const taxCategoryId = l.taxCategoryId
        ? BigInt(l.taxCategoryId)
        : (item.taxCategoryId ?? defaultTax?.id ?? null);
      const taxRate = taxCategoryId
        ? new Decimal(taxById.get(taxCategoryId)?.rate ?? item.taxCategory?.rate ?? defaultTax?.rate ?? 0)
        : new Decimal(0);

      const qty = new Decimal(l.qty);
      if (qty.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Line qty must be > 0');
      const amounts = computeLineAmounts({
        qty: l.qty,
        factorToBase,
        unitPrice: l.unitPrice,
        discountPct: l.discountPct ?? '0',
        taxRate,
      });
      out.push({
        dto: l,
        itemId: item.id,
        itemUnitId,
        factorToBase,
        itemKind: item.itemKind,
        taxRate,
        taxCategoryId,
        amounts,
      });
    }
    return out;
  }
}
