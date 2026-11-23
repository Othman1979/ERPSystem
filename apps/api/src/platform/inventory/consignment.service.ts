import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { branchSql, branchWhere, hasAllBranches } from '../../common/branch/branch-context.js';
import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { currentCompanyFilter } from '../../common/cls/current-company.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import type {
  ConsignmentAgingQueryDto,
  ConsignmentOpenSalesQueryDto,
  ConsignmentStatementQueryDto,
} from './dto/consignment.dto.js';

const MAX_ROWS = 500;

function warehouseScope(): { warehouse?: ReturnType<typeof branchWhere> } {
  return hasAllBranches() ? {} : { warehouse: branchWhere() };
}

function sourceBranchScope() {
  if (hasAllBranches()) return Prisma.sql`TRUE`;
  return Prisma.sql`(
    (s.source_type = 'SALES_INVOICE' AND ${branchSql(Prisma.raw('si.branch_id'))})
    OR (s.source_type = 'STOCK_COUNT' AND ${branchSql(Prisma.raw('w.branch_id'))})
  )`;
}

@Injectable()
export class ConsignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly support: DocumentSupportService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: ReturnType<PrismaService['forTenant']>) {
    const company = await db.company.findFirst({
      where: { isActive: true, ...currentCompanyFilter() },
      select: { id: true, consignmentEnabled: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    if (!company.consignmentEnabled) {
      throw new DomainError(ErrorCode.CONSIGNMENT_DISABLED, 'Temporary receipt is disabled for this company');
    }
    return company.id;
  }

  async openSales(query: ConsignmentOpenSalesQueryDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const supplierId = query.supplierId ? BigInt(query.supplierId) : null;
    const warehouseId = query.warehouseId ? BigInt(query.warehouseId) : null;
    if (supplierId !== null) await this.assertSupplier(db, companyId, supplierId);
    if (warehouseId !== null) {
      const warehouse = await db.warehouse.findFirst({
        where: { companyId, id: warehouseId, ...branchWhere() },
        select: { id: true, consignmentSupplierId: true },
      });
      if (!warehouse) throw DomainError.notFound('Warehouse', query.warehouseId!);
      if (warehouse.consignmentSupplierId === null) {
        throw new DomainError(ErrorCode.CONSIGNMENT_WAREHOUSE_NOT_ALLOWED, 'Open temporary-receipt sales require a temporary warehouse');
      }
      if (supplierId !== null && warehouse.consignmentSupplierId !== supplierId) {
        throw new DomainError(ErrorCode.PARTY_TYPE_MISMATCH, 'Supplier does not match the temporary warehouse');
      }
    }
    const filters = [
      Prisma.sql`s.company_id = ${companyId}`,
      Prisma.sql`s.qty > s.returned_qty + s.invoiced_qty`,
      ...(supplierId === null ? [] : [Prisma.sql`s.supplier_id = ${supplierId}`]),
      ...(warehouseId === null ? [] : [Prisma.sql`s.warehouse_id = ${warehouseId}`]),
    ];
    const ids = await db.$queryRaw<{ id: bigint }[]>`
      SELECT s.id
        FROM consignment_sales s
        JOIN warehouses w
          ON w.tenant_id = s.tenant_id AND w.company_id = s.company_id AND w.id = s.warehouse_id
        LEFT JOIN sales_invoices si
          ON s.source_type = 'SALES_INVOICE' AND si.tenant_id = s.tenant_id AND si.id = s.source_id
       WHERE s.tenant_id = ${tenantId}
         AND ${branchSql(Prisma.raw('w.branch_id'))}
         AND ${sourceBranchScope()}
         AND ${Prisma.join(filters, ' AND ')}
       ORDER BY s.sale_date, s.id LIMIT ${MAX_ROWS + 1}`;
    if (ids.length > MAX_ROWS) {
      throw new DomainError(ErrorCode.REPORT_TOO_LARGE, 'Narrow the supplier or warehouse filter', { limit: MAX_ROWS });
    }
    const rows = await db.consignmentSale.findMany({
      where: { id: { in: ids.map((row) => row.id) }, ...warehouseScope() },
      orderBy: [{ saleDate: 'asc' }, { id: 'asc' }],
      include: { item: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
    });
    const sourceNumbers = await this.sourceNumbers(db, companyId, rows);
    return rows.map((row) => {
      const openQty = new Decimal(row.qty.toString()).minus(row.returnedQty.toString()).minus(row.invoicedQty.toString());
      return {
        ...row,
        qty: row.qty.toString(),
        returnedQty: row.returnedQty.toString(),
        invoicedQty: row.invoicedQty.toString(),
        openQty: openQty.toString(),
        sourceNo: sourceNumbers.get(`${row.sourceType}:${row.sourceId}`) ?? null,
      };
    });
  }

  async statement(query: ConsignmentStatementQueryDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const supplierId = BigInt(query.supplierId);
    await this.assertSupplier(db, companyId, supplierId);
    if (query.from > query.to) throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to');
    const range = { gte: new Date(query.from), lte: new Date(query.to) };
    const [saleIds, movementGroups, balances] = await Promise.all([
      db.$queryRaw<{ id: bigint }[]>`
        SELECT s.id
          FROM consignment_sales s
          JOIN warehouses w
            ON w.tenant_id = s.tenant_id AND w.company_id = s.company_id AND w.id = s.warehouse_id
          LEFT JOIN sales_invoices si
            ON s.source_type = 'SALES_INVOICE' AND si.tenant_id = s.tenant_id AND si.id = s.source_id
         WHERE s.tenant_id = ${tenantId} AND s.company_id = ${companyId}
           AND s.supplier_id = ${supplierId} AND s.sale_date >= ${range.gte} AND s.sale_date <= ${range.lte}
           AND ${branchSql(Prisma.raw('w.branch_id'))}
           AND ${sourceBranchScope()}
         ORDER BY s.sale_date, s.id LIMIT ${MAX_ROWS + 1}`,
      db.stockMovement.groupBy({
        by: ['itemId', 'sourceType'],
        where: {
          companyId,
          movementDate: range,
          sourceType: { in: ['CONSIGNMENT_IN', 'CONSIGNMENT_OUT'] },
          warehouse: { consignmentSupplierId: supplierId, ...branchWhere() },
        },
        _sum: { qtyIn: true, qtyOut: true },
        orderBy: [{ itemId: 'asc' }, { sourceType: 'asc' }],
        take: MAX_ROWS + 1,
      }),
      db.stockBalance.groupBy({
        by: ['itemId'],
        where: { warehouse: { companyId, consignmentSupplierId: supplierId, ...branchWhere() } },
        _sum: { qtyOnHand: true },
        orderBy: { itemId: 'asc' },
        take: MAX_ROWS + 1,
      }),
    ]);
    const sales = await db.consignmentSale.findMany({
      where: { companyId, supplierId, saleDate: range, id: { in: saleIds.map((row) => row.id) }, ...warehouseScope() },
      orderBy: [{ saleDate: 'asc' }, { id: 'asc' }],
    });
    if (saleIds.length > MAX_ROWS || movementGroups.length > MAX_ROWS || balances.length > MAX_ROWS) {
      throw new DomainError(ErrorCode.REPORT_TOO_LARGE, 'Narrow the statement date range', { limit: MAX_ROWS });
    }
    const itemIds = [...new Set([
      ...sales.map((row) => row.itemId),
      ...movementGroups.map((row) => row.itemId),
      ...balances.map((row) => row.itemId),
    ])];
    if (itemIds.length > MAX_ROWS) {
      throw new DomainError(ErrorCode.REPORT_TOO_LARGE, 'Narrow the statement date range', { limit: MAX_ROWS });
    }
    const items = await db.item.findMany({
      where: { companyId, id: { in: itemIds } },
      select: { id: true, code: true, nameAr: true, nameEn: true },
    });
    const itemById = new Map(items.map((item) => [item.id, item]));
    const balanceByItem = new Map(balances.map((row) => [row.itemId, new Decimal(row._sum?.qtyOnHand?.toString() ?? 0)]));
    const out = itemIds.map((itemId) => {
      const itemSales = sales.filter((row) => row.itemId === itemId);
      const movement = (sourceType: string) => movementGroups.find((row) => row.itemId === itemId && row.sourceType === sourceType);
      const received = new Decimal(movement('CONSIGNMENT_IN')?._sum.qtyIn?.toString() ?? 0);
      const returnedToSupplier = new Decimal(movement('CONSIGNMENT_OUT')?._sum.qtyOut?.toString() ?? 0);
      const sold = sum(itemSales.filter((row) => row.sourceType === 'SALES_INVOICE').map((row) =>
        new Decimal(row.qty.toString()).minus(row.returnedQty.toString()),
      ));
      const shortage = sum(itemSales.filter((row) => row.sourceType === 'STOCK_COUNT').map((row) => row.qty));
      const invoicedQty = sum(itemSales.map((row) => row.invoicedQty));
      const openQty = sum(itemSales.map((row) =>
        new Decimal(row.qty.toString()).minus(row.returnedQty.toString()).minus(row.invoicedQty.toString()),
      ));
      return {
        item: itemById.get(itemId),
        receivedQty: received.toString(),
        returnedToSupplierQty: returnedToSupplier.toString(),
        soldNetOfReturnsQty: sold.toString(),
        countShortageQty: shortage.toString(),
        invoicedQty: invoicedQty.toString(),
        onHandQty: (balanceByItem.get(itemId) ?? new Decimal(0)).toString(),
        openQty: openQty.toString(),
      };
    });
    return out.filter((row) => row.item !== undefined);
  }

  async aging(query: ConsignmentAgingQueryDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const supplierId = query.supplierId ? BigInt(query.supplierId) : null;
    if (supplierId !== null) await this.assertSupplier(db, companyId, supplierId);
    const asOf = new Date(`${await this.support.companyToday(db)}T00:00:00.000Z`);
    const filters = [
      Prisma.sql`s.company_id = ${companyId}`,
      Prisma.sql`s.qty > s.returned_qty + s.invoiced_qty`,
      ...(supplierId === null ? [] : [Prisma.sql`s.supplier_id = ${supplierId}`]),
    ];
    const ids = await db.$queryRaw<{ id: bigint }[]>`
      SELECT s.id
        FROM consignment_sales s
        JOIN warehouses w
          ON w.tenant_id = s.tenant_id AND w.company_id = s.company_id AND w.id = s.warehouse_id
        LEFT JOIN sales_invoices si
          ON s.source_type = 'SALES_INVOICE' AND si.tenant_id = s.tenant_id AND si.id = s.source_id
       WHERE s.tenant_id = ${tenantId}
         AND ${branchSql(Prisma.raw('w.branch_id'))}
         AND ${sourceBranchScope()}
         AND ${Prisma.join(filters, ' AND ')}
       ORDER BY s.sale_date, s.id LIMIT ${MAX_ROWS + 1}`;
    if (ids.length > MAX_ROWS) {
      throw new DomainError(ErrorCode.REPORT_TOO_LARGE, 'Narrow the supplier filter', { limit: MAX_ROWS });
    }
    const rows = await db.consignmentSale.findMany({
      where: { id: { in: ids.map((row) => row.id) }, ...warehouseScope() },
      orderBy: [{ saleDate: 'asc' }, { id: 'asc' }],
      include: { item: { select: { id: true, code: true, nameAr: true, nameEn: true } } },
    });
    const sourceNumbers = await this.sourceNumbers(db, companyId, rows);
    return rows.map((row) => {
      const age = Math.max(0, Math.floor((asOf.getTime() - row.saleDate.getTime()) / 86_400_000));
      const openQty = new Decimal(row.qty.toString()).minus(row.returnedQty.toString()).minus(row.invoicedQty.toString());
      return {
        ...row,
        openQty: openQty.toString(),
        sourceNo: sourceNumbers.get(`${row.sourceType}:${row.sourceId}`) ?? null,
        ageDays: age,
        ageBucket: age <= 30 ? '0-30' : age <= 60 ? '31-60' : age <= 90 ? '61-90' : '90+',
      };
    });
  }

  private async sourceNumbers(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    rows: Array<{ sourceType: string; sourceId: bigint }>,
  ) {
    const invoiceIds = [...new Set(rows.filter((row) => row.sourceType === 'SALES_INVOICE').map((row) => row.sourceId))];
    const countIds = [...new Set(rows.filter((row) => row.sourceType === 'STOCK_COUNT').map((row) => row.sourceId))];
    const [invoices, counts] = await Promise.all([
      db.salesInvoice.findMany({
        where: { companyId, id: { in: invoiceIds } },
        select: { id: true, invoiceNo: true },
      }),
      db.stockCount.findMany({
        where: { companyId, id: { in: countIds } },
        select: { id: true, docNo: true },
      }),
    ]);
    return new Map([
      ...invoices.map((row) => [`SALES_INVOICE:${row.id}`, row.invoiceNo] as const),
      ...counts.map((row) => [`STOCK_COUNT:${row.id}`, row.docNo] as const),
    ]);
  }

  private async assertSupplier(db: ReturnType<PrismaService['forTenant']>, companyId: bigint, supplierId: bigint) {
    const supplier = await db.party.findFirst({
      where: { id: supplierId, companyId, partyType: { in: ['SUPPLIER', 'BOTH'] } },
      select: { id: true },
    });
    if (!supplier) throw DomainError.notFound('Supplier', supplierId.toString());
  }
}
