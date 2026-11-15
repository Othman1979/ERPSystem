/**
 * Response shapes of the sales-cycle routes (ADR-027, ADR-023): what
 * SalesQuotesService, SalesOrdersService and SalesInvoicesService return today.
 * Nothing here changes a body. The invoice routes answer with SalesInvoiceDetailDto.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  CostCenterRow,
  ItemRow,
  ItemUnitRow,
  PartyRow,
  SalesOrderLineRow,
  SalesOrderRow,
  SalesQuoteLineRow,
  SalesQuoteRow,
  UnitRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';
import { SalesOrderStatus, SalesReservation } from '../../../generated/prisma/enums.js';

// ----------------------------------------------------------- shared refs

/** Customer summary on a list row (the sales-cycle list services). */
export class SalesCycleCustomerRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** Customer on a quote or order detail (printed for the customer). */
export class SalesCycleCustomerDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'nameEn', 'taxNumber', 'phone', 'address'] as const) {}

/** Item summary on a quote or order line. */
export class SalesCycleItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'nameEn', 'baseUnitId', 'itemKind'] as const) {}

/** Unit summary of an item unit. */
export class SalesCycleUnitRefDto extends PickType(UnitRow, ['id', 'code', 'nameAr'] as const) {}

/** An item unit with its unit (`include: { unit }`). */
export class SalesCycleItemUnitDto extends ItemUnitRow {
  @ApiProperty({ type: () => SalesCycleUnitRefDto })
  unit!: SalesCycleUnitRefDto;
}

/** Warehouse summary on a quote or order detail. */
export class SalesCycleWarehouseRefDto extends PickType(WarehouseRow, ['id', 'code', 'nameAr'] as const) {}

/** Cost centre summary on a quote or order detail. */
export class SalesCycleCostCenterRefDto extends PickType(CostCenterRow, ['id', 'code', 'nameAr'] as const) {}

/** Count of a document's lines (`_count` in the list rows). */
export class SalesCycleLineCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

/** The quote an order was made from, on an order list row. */
export class SalesCycleQuoteNoRefDto extends PickType(SalesQuoteRow, ['id', 'quoteNo'] as const) {}

/** The quote an order was made from, on an order detail. */
export class SalesCycleQuoteStatusRefDto extends PickType(SalesQuoteRow, ['id', 'quoteNo', 'status'] as const) {}

// ------------------------------------------------------- sales quotations

/** A sales quote list row (SalesQuotesService.list): customer and line count. */
export class SalesCycleQuoteListItemDto extends SalesQuoteRow {
  @ApiProperty({ type: () => SalesCycleCustomerRefDto })
  customer!: SalesCycleCustomerRefDto;

  @ApiProperty({ type: () => SalesCycleLineCountDto })
  _count!: SalesCycleLineCountDto;
}

/** A sales quote line: every column of `sales_quote_lines` plus its item and item unit. */
export class SalesCycleQuoteLineViewDto extends SalesQuoteLineRow {
  @ApiProperty({ type: () => SalesCycleItemRefDto })
  item!: SalesCycleItemRefDto;

  @ApiProperty({ type: () => SalesCycleItemUnitDto, nullable: true })
  itemUnit!: SalesCycleItemUnitDto | null;
}

/** A sales quote with its lines, customer, warehouse and cost centre, and its computed `expired` flag (SalesQuotesService.get). */
export class SalesCycleQuoteDetailDto extends SalesQuoteRow {
  @ApiProperty({ type: () => SalesCycleCustomerDto })
  customer!: SalesCycleCustomerDto;

  @ApiProperty({ type: () => SalesCycleWarehouseRefDto, nullable: true })
  warehouse!: SalesCycleWarehouseRefDto | null;

  @ApiProperty({ type: () => SalesCycleCostCenterRefDto, nullable: true })
  costCenter!: SalesCycleCostCenterRefDto | null;

  @ApiProperty({ type: () => SalesCycleQuoteLineViewDto, isArray: true })
  lines!: SalesCycleQuoteLineViewDto[];

  @ApiProperty({ type: 'boolean', description: 'SENT and past its validUntil date; computed, not stored.' })
  expired!: boolean;
}

// ------------------------------------------------------- sales orders

/** A sales order list row (SalesOrdersService.list): customer, source quote and line count. */
export class SalesCycleOrderListItemDto extends SalesOrderRow {
  @ApiProperty({ type: () => SalesCycleCustomerRefDto })
  customer!: SalesCycleCustomerRefDto;

  @ApiProperty({ type: () => SalesCycleQuoteNoRefDto, nullable: true })
  quote!: SalesCycleQuoteNoRefDto | null;

  @ApiProperty({ type: () => SalesCycleLineCountDto })
  _count!: SalesCycleLineCountDto;
}

/** A sales order line: every column of `sales_order_lines` plus its item and item unit. */
export class SalesCycleOrderLineViewDto extends SalesOrderLineRow {
  @ApiProperty({ type: () => SalesCycleItemRefDto })
  item!: SalesCycleItemRefDto;

  @ApiProperty({ type: () => SalesCycleItemUnitDto, nullable: true })
  itemUnit!: SalesCycleItemUnitDto | null;
}

/** A sales order with its lines, customer, warehouse, cost centre and source quote (SalesOrdersService.get). */
export class SalesCycleOrderDetailDto extends SalesOrderRow {
  @ApiProperty({ type: () => SalesCycleCustomerDto })
  customer!: SalesCycleCustomerDto;

  @ApiProperty({ type: () => SalesCycleWarehouseRefDto })
  warehouse!: SalesCycleWarehouseRefDto;

  @ApiProperty({ type: () => SalesCycleCostCenterRefDto, nullable: true })
  costCenter!: SalesCycleCostCenterRefDto | null;

  @ApiProperty({ type: () => SalesCycleQuoteStatusRefDto, nullable: true })
  quote!: SalesCycleQuoteStatusRefDto | null;

  @ApiProperty({ type: () => SalesCycleOrderLineViewDto, isArray: true })
  lines!: SalesCycleOrderLineViewDto[];
}

// ----------------------------------------------------------- reservation

/** One stock item of a warehouse: on hand, and (unless reservation is NONE) reserved and available. */
export class SalesCycleReservationItemDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Base-unit quantity on hand.' })
  onHand!: string;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true, description: 'Null when reservation is NONE.' })
  reserved!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true, description: 'Null when reservation is NONE.' })
  available!: string | null;
}

/** Reserved and available quantities of stock items in one warehouse (SalesOrdersService.reservation). */
export class SalesCycleReservationDto {
  @ApiProperty({ type: 'string' })
  warehouseId!: string;

  @ApiProperty({ enum: SalesReservation, enumName: 'SalesReservation', description: 'The company setting of ADR-027 §5.' })
  mode!: SalesReservation;

  @ApiProperty({ type: () => SalesCycleReservationItemDto, isArray: true })
  items!: SalesCycleReservationItemDto[];
}

// ----------------------------------------------------------- invoiceable

/** What one order line still allows to invoice, in base units and in the line's unit (rounded down). */
export class SalesCycleInvoiceableLineDto {
  @ApiProperty({ type: 'string' })
  orderLineId!: string;

  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  itemUnitId!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  invoicedQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  remainingBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  remainingQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unitPrice!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  discountPct!: string;

  @ApiProperty({ type: 'string', nullable: true })
  taxCategoryId!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  taxRate!: string;
}

/** The quantities a sales order still allows to invoice, per line (SalesInvoicesService.invoiceable). */
export class SalesCycleInvoiceableDto {
  @ApiProperty({ type: 'string' })
  orderId!: string;

  @ApiProperty({ enum: SalesOrderStatus, enumName: 'SalesOrderStatus' })
  status!: SalesOrderStatus;

  @ApiProperty({ type: 'boolean', description: 'True when the order status takes invoices (ADR-027 §4).' })
  invoiceable!: boolean;

  @ApiProperty({ type: () => SalesCycleInvoiceableLineDto, isArray: true })
  lines!: SalesCycleInvoiceableLineDto[];
}
