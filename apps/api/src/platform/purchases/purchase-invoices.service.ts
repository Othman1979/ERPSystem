import { Injectable } from '@nestjs/common';
import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { computeLineAmounts } from '../shared/invoice-math.js';
import { creditedByInvoice, withBalance } from '../shared/invoice-balance.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import type { CreatePurchaseInvoiceDto, PurchaseInvoiceLineDto } from './dto/purchases.dto.js';

const SOURCE = 'PURCHASE_INVOICE';

interface ResolvedLine {
  dto: PurchaseInvoiceLineDto;
  itemId: bigint;
  itemUnitId: bigint | null;
  factorToBase: Decimal;
  itemKind: 'STOCK' | 'SERVICE';
  taxRate: Decimal;
  taxCategoryId: bigint | null;
  amounts: ReturnType<typeof computeLineAmounts>;
}

/**
 * Purchase invoices: draft CRUD + post → stock IN (STOCK lines, at
 * netAmount/qtyBase cost) + inventory/purchases/tax journal (§8.4).
 */
@Injectable()
export class PurchaseInvoicesService {
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
    const returns = await db.purchaseReturn.findMany({
      where: { originalInvoiceId: { in: invoiceIds }, status: 'POSTED', refundType: 'CREDIT' },
      select: { originalInvoiceId: true, grandTotal: true },
    });
    return creditedByInvoice(returns);
  }

  async list(status?: string, paymentType?: string, supplierId?: string) {
    const { db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const rows = await db.purchaseInvoice.findMany({
      where: {
        companyId,
        ...(status ? { status: status as 'DRAFT' | 'POSTED' } : {}),
        ...(paymentType ? { paymentType: paymentType as 'CASH' | 'CREDIT' } : {}),
        ...(supplierId ? { supplierId: BigInt(supplierId) } : {}),
      },
      include: {
        supplier: { select: { id: true, code: true, nameAr: true } },
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
    const inv = await db.purchaseInvoice.findFirst({
      where: { id },
      include: {
        supplier: true,
        warehouse: { select: { id: true, code: true, nameAr: true } },
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
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    return withBalance(inv, await this.creditedFor(db, [inv.id]));
  }

  async create(dto: CreatePurchaseInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines);
    await this.assertHeader(db, companyId, dto, lines);

    const inv = await db.$transaction(async (tx) => {
      const created = await tx.purchaseInvoice.create({
        data: {
          tenantId,
          companyId,
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          supplierId: BigInt(dto.supplierId),
          supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
          supplierInvoiceDate: dto.supplierInvoiceDate ? new Date(dto.supplierInvoiceDate) : null,
          warehouseId: dto.warehouseId ? BigInt(dto.warehouseId) : null,
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          description: dto.description ?? null,
          ...this.totals(lines),
          createdBy: this.support.userId() ?? null,
        },
      });
      await tx.purchaseInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: created.id,
          lineNo: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitCost: l.dto.unitCost,
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
      action: 'purchase_invoice.create',
      entityType: 'purchase_invoice',
      entityId: inv.id,
      after: { lines: lines.length },
    });
    return this.get(inv.id);
  }

  async update(id: bigint, dto: CreatePurchaseInvoiceDto) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const inv = await db.purchaseInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be modified');
    }
    const lines = await this.resolveLines(db, tenantId, companyId, dto.lines);
    await this.assertHeader(db, companyId, dto, lines);

    await db.$transaction(async (tx) => {
      await tx.purchaseInvoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.purchaseInvoice.update({
        where: { id },
        data: {
          invoiceDate: new Date(dto.invoiceDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          supplierId: BigInt(dto.supplierId),
          supplierInvoiceNo: dto.supplierInvoiceNo ?? null,
          supplierInvoiceDate: dto.supplierInvoiceDate ? new Date(dto.supplierInvoiceDate) : null,
          warehouseId: dto.warehouseId ? BigInt(dto.warehouseId) : null,
          paymentType: dto.paymentType,
          cashAccountId: dto.cashAccountId ? BigInt(dto.cashAccountId) : null,
          description: dto.description ?? null,
          ...this.totals(lines),
          updatedBy: this.support.userId() ?? null,
        },
      });
      await tx.purchaseInvoiceLine.createMany({
        data: lines.map((l, i) => ({
          tenantId,
          invoiceId: id,
          lineNo: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId,
          qty: l.dto.qty,
          qtyBase: l.amounts.qtyBase,
          unitCost: l.dto.unitCost,
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
      action: 'purchase_invoice.update',
      entityType: 'purchase_invoice',
      entityId: id,
    });
    return this.get(id);
  }

  async deleteDraft(id: bigint) {
    const { db } = this.support.tenant();
    const inv = await db.purchaseInvoice.findFirst({ where: { id } });
    if (!inv) throw DomainError.notFound('PurchaseInvoice', id.toString());
    if (inv.status !== 'DRAFT') {
      throw new DomainError(ErrorCode.CONFLICT, 'Only draft invoices can be deleted');
    }
    await db.purchaseInvoice.delete({ where: { id } });
    return { deleted: true };
  }

  /** Posts: stock IN per STOCK line + inventory/purchases/tax journal (§8.4). */
  async post(id: bigint) {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const userId = this.support.userId();

    const result = await this.support.withRetry(() =>
      db.$transaction(async (tx) => {
        const draft = await tx.purchaseInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        });
        if (!draft) throw DomainError.notFound('PurchaseInvoice', id.toString());
        if (draft.status !== 'DRAFT') {
          throw new DomainError(ErrorCode.CONFLICT, 'Invoice is not a draft');
        }
        if (draft.lines.length === 0) {
          throw new DomainError(ErrorCode.VALIDATION, 'Invoice has no lines');
        }
        if (draft.paymentType === 'CASH' && !draft.cashAccountId) {
          throw new DomainError(ErrorCode.VALIDATION, 'cashAccountId is required for cash invoices');
        }

        const hasStock = await this.hasStockLines(tx, tenantId, draft.lines.map((l) => l.itemId));
        if (hasStock && !draft.warehouseId) {
          throw new DomainError(ErrorCode.VALIDATION, 'warehouseId is required for stocked items');
        }
        if (draft.warehouseId) {
          const wh = await tx.warehouse.findFirst({
            where: { id: draft.warehouseId, companyId, isActive: true },
            select: { id: true },
          });
          if (!wh) throw DomainError.notFound('Warehouse', draft.warehouseId.toString());
        }

        const invoiceDate = new Date(draft.invoiceDate);
        const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, invoiceDate);

        // Stock IN for STOCK lines at net cost per base unit.
        let stockNet = new Decimal(0);
        let serviceNet = new Decimal(0);
        for (const line of draft.lines) {
          const item = await tx.item.findFirst({
            where: { tenantId, id: line.itemId },
            select: { itemKind: true },
          });
          if (!item) throw DomainError.notFound('Item', line.itemId.toString());
          if (item.itemKind === 'STOCK') {
            const unitCost = new Decimal(line.netAmount.toString()).div(line.qtyBase.toString());
            await this.ledger.applyMovement(tx, companyId, {
              warehouseId: draft.warehouseId!,
              itemId: line.itemId,
              movementDate: invoiceDate,
              type: 'IN',
              qty: line.qtyBase.toString(),
              unitCost: unitCost.toString(),
              sourceType: SOURCE,
              sourceId: draft.id,
              sourceLineId: line.id,
              description: `Purchase invoice ${draft.id}`,
            });
            stockNet = stockNet.plus(line.netAmount);
          } else {
            serviceNet = serviceNet.plus(line.netAmount);
          }
        }

        const mapping = await this.support.mappingAccounts(tx, tenantId, companyId, [
          'INVENTORY',
          'PURCHASES',
          'INPUT_TAX',
          'SUPPLIERS_CONTROL',
        ]);

        const journalLines: JournalLineInput[] = [];
        const grand = draft.grandTotal;
        const tax = draft.taxTotal;

        if (stockNet.gt(0)) {
          journalLines.push({ accountId: mapping.INVENTORY, debit: stockNet.toString() });
        }
        if (serviceNet.gt(0)) {
          journalLines.push({ accountId: mapping.PURCHASES, debit: serviceNet.toString() });
        }
        if (tax.gt(0)) {
          journalLines.push({ accountId: mapping.INPUT_TAX, debit: tax.toString() });
        }
        if (draft.paymentType === 'CASH') {
          journalLines.push({
            accountId: draft.cashAccountId!,
            credit: grand.toString(),
            description: 'Cash purchase',
          });
        } else {
          journalLines.push({
            accountId: mapping.SUPPLIERS_CONTROL,
            credit: grand.toString(),
            partyType: 'SUPPLIER',
            partyId: draft.supplierId,
            description: 'Credit purchase',
          });
        }

        const invoiceNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'PURCHASE_INVOICE', invoiceDate,
        );
        const entryNo = await this.posting.allocateEntryNo(
          tx, tenantId, companyId, 'JOURNAL_ENTRY', invoiceDate,
        );
        const entry = await this.posting.postEntry(tx, {
          tenantId,
          companyId,
          entryDate: invoiceDate,
          fiscalPeriodId: period.id,
          entryNo,
          sourceType: SOURCE,
          sourceId: draft.id,
          description: draft.description ?? `Purchase invoice ${invoiceNo}`,
          lines: journalLines,
          postedBy: userId ?? null,
        });

        await tx.purchaseInvoice.update({
          where: { id: draft.id },
          data: {
            status: 'POSTED',
            invoiceNo,
            journalEntryId: entry.id,
            postedAt: new Date(),
            postedBy: userId ?? null,
          },
        });
        return { id: draft.id, invoiceNo };
      }),
    );

    await this.audit.log({
      action: 'purchase_invoice.post',
      entityType: 'purchase_invoice',
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

  private async hasStockLines(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    itemIds: bigint[],
  ): Promise<boolean> {
    const items = await tx.item.findMany({
      where: { tenantId, id: { in: itemIds } },
      select: { itemKind: true },
    });
    return items.some((i) => i.itemKind === 'STOCK');
  }

  private async assertHeader(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    dto: CreatePurchaseInvoiceDto,
    lines: ResolvedLine[],
  ) {
    const supplier = await db.party.findFirst({
      where: { companyId, id: BigInt(dto.supplierId), isActive: true },
      select: { id: true, partyType: true },
    });
    if (!supplier || (supplier.partyType !== 'SUPPLIER' && supplier.partyType !== 'BOTH')) {
      throw new DomainError(ErrorCode.VALIDATION, 'Supplier not found or not a supplier');
    }
    const hasStock = lines.some((l) => l.itemKind === 'STOCK');
    if (hasStock) {
      if (!dto.warehouseId) {
        throw new DomainError(ErrorCode.VALIDATION, 'warehouseId is required for stocked items');
      }
      const wh = await db.warehouse.findFirst({
        where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
        select: { id: true },
      });
      if (!wh) throw DomainError.notFound('Warehouse', dto.warehouseId);
    } else if (dto.warehouseId) {
      const wh = await db.warehouse.findFirst({
        where: { companyId, id: BigInt(dto.warehouseId), isActive: true },
        select: { id: true },
      });
      if (!wh) throw DomainError.notFound('Warehouse', dto.warehouseId);
    }
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
    dtos: PurchaseInvoiceLineDto[],
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
        unitPrice: l.unitCost,
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
