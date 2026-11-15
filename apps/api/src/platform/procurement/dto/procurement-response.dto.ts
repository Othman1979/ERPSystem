/**
 * Response shapes of the procurement routes (ADR-023): what
 * PurchaseRequestsService / PurchaseQuotesService / PurchaseOrdersService return.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  CostCenterRow,
  ItemRow,
  ItemUnitRow,
  PartyRow,
  PurchaseOrderLineRow,
  PurchaseOrderRow,
  PurchaseQuoteLineRow,
  PurchaseQuoteRow,
  PurchaseRequestLineRow,
  PurchaseRequestRow,
  UnitRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';
import { PurchaseRequestStatus } from '../../../generated/prisma/enums.js';

// ----------------------------------------------------------- shared refs

export class ProcurementSupplierRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** The supplier on a quote or order detail (printed for the supplier). */
export class ProcurementSupplierDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'nameEn', 'taxNumber', 'phone', 'address'] as const) {}

export class ProcurementItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'nameEn', 'baseUnitId', 'itemKind'] as const) {}

export class ProcurementUnitRefDto extends PickType(UnitRow, ['id', 'code', 'nameAr'] as const) {}

export class ProcurementItemUnitDto extends ItemUnitRow {
  @ApiProperty({ type: () => ProcurementUnitRefDto })
  unit!: ProcurementUnitRefDto;
}

export class ProcurementLineCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

/** The request a quote or order refers to. */
export class ProcurementRequestRefDto extends PickType(PurchaseRequestRow, ['id', 'requestNo', 'status'] as const) {}

/** The request on a list row. */
export class ProcurementRequestNoDto extends PickType(PurchaseRequestRow, ['id', 'requestNo'] as const) {}

/** A request line a quote or order line refers to. */
export class ProcurementRequestLineRefDto extends PickType(PurchaseRequestLineRow, ['id', 'lineNo'] as const) {}

// ------------------------------------------------------- purchase requests

export class PurchaseRequestListItemDto extends PurchaseRequestRow {
  @ApiProperty({ type: () => ProcurementLineCountDto })
  _count!: ProcurementLineCountDto;
}

export class PurchaseRequestLineViewDto extends PurchaseRequestLineRow {
  @ApiProperty({ type: () => ProcurementItemRefDto })
  item!: ProcurementItemRefDto;

  @ApiProperty({ type: () => ProcurementItemUnitDto, nullable: true })
  itemUnit!: ProcurementItemUnitDto | null;

  /** qty − orderedQty: what is left to order, in the line's unit. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  remainingQty!: string;
}

export class PurchaseRequestQuoteRefDto extends PickType(PurchaseQuoteRow, ['id', 'quoteNo', 'status', 'quoteDate', 'grandTotal'] as const) {
  @ApiProperty({ type: () => ProcurementSupplierRefDto })
  supplier!: ProcurementSupplierRefDto;
}

export class PurchaseRequestOrderRefDto extends PickType(PurchaseOrderRow, ['id', 'orderNo', 'status', 'orderDate', 'grandTotal'] as const) {
  @ApiProperty({ type: () => ProcurementSupplierRefDto })
  supplier!: ProcurementSupplierRefDto;
}

export class PurchaseRequestDetailDto extends PurchaseRequestRow {
  @ApiProperty({ type: () => PurchaseRequestLineViewDto, isArray: true })
  lines!: PurchaseRequestLineViewDto[];

  @ApiProperty({ type: () => PurchaseRequestQuoteRefDto, isArray: true })
  quotes!: PurchaseRequestQuoteRefDto[];

  @ApiProperty({ type: () => PurchaseRequestOrderRefDto, isArray: true })
  orders!: PurchaseRequestOrderRefDto[];
}

// ----------------------------------------------------------------- quotes

export class PurchaseQuoteListItemDto extends PurchaseQuoteRow {
  @ApiProperty({ type: () => ProcurementSupplierRefDto })
  supplier!: ProcurementSupplierRefDto;

  @ApiProperty({ type: () => ProcurementRequestNoDto })
  request!: ProcurementRequestNoDto;

  @ApiProperty({ type: () => ProcurementLineCountDto })
  _count!: ProcurementLineCountDto;
}

export class PurchaseQuoteLineViewDto extends PurchaseQuoteLineRow {
  @ApiProperty({ type: () => ProcurementItemRefDto })
  item!: ProcurementItemRefDto;

  @ApiProperty({ type: () => ProcurementItemUnitDto, nullable: true })
  itemUnit!: ProcurementItemUnitDto | null;

  @ApiProperty({ type: () => ProcurementRequestLineRefDto })
  requestLine!: ProcurementRequestLineRefDto;
}

export class PurchaseQuoteDetailDto extends PurchaseQuoteRow {
  @ApiProperty({ type: () => ProcurementSupplierDto })
  supplier!: ProcurementSupplierDto;

  @ApiProperty({ type: () => ProcurementRequestRefDto })
  request!: ProcurementRequestRefDto;

  @ApiProperty({ type: () => PurchaseQuoteLineViewDto, isArray: true })
  lines!: PurchaseQuoteLineViewDto[];
}

/** One received quote's price for a request line (the comparison). */
export class ComparisonOfferDto {
  @ApiProperty({ type: 'string' })
  quoteId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  quoteNo!: string | null;

  @ApiProperty({ type: 'string' })
  quoteLineId!: string;

  @ApiProperty({ type: () => ProcurementSupplierRefDto })
  supplier!: ProcurementSupplierRefDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unitPrice!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  discountPct!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  netAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  taxAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  lineTotal!: string;

  @ApiProperty({ type: 'boolean' })
  pricesIncludeTax!: boolean;

  /** lineTotal / qty, tax included, 6 decimals: what the offers are compared on. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  unitTotal!: string;

  /** The lowest unitTotal of the line (ties all marked). */
  @ApiProperty({ type: 'boolean' })
  lowest!: boolean;
}

export class ComparisonLineDto {
  @ApiProperty({ type: 'string' })
  requestLineId!: string;

  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: () => ProcurementItemRefDto })
  item!: ProcurementItemRefDto;

  @ApiProperty({ type: () => ProcurementItemUnitDto, nullable: true })
  itemUnit!: ProcurementItemUnitDto | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  orderedQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  remainingQty!: string;

  @ApiProperty({ type: () => ComparisonOfferDto, isArray: true })
  offers!: ComparisonOfferDto[];
}

export class ComparisonRequestDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', nullable: true })
  requestNo!: string | null;

  @ApiProperty({ enum: PurchaseRequestStatus, enumName: 'PurchaseRequestStatus' })
  status!: PurchaseRequestStatus;

  @ApiProperty({ type: 'string', format: 'date-time' })
  requestDate!: string;
}

/** GET /purchase-requests/:id/comparison (ADR-025 §10). */
export class PurchaseComparisonDto {
  @ApiProperty({ type: () => ComparisonRequestDto })
  request!: ComparisonRequestDto;

  @ApiProperty({ type: () => ComparisonLineDto, isArray: true })
  lines!: ComparisonLineDto[];
}

// ----------------------------------------------------------------- orders

export class PurchaseOrderListItemDto extends PurchaseOrderRow {
  @ApiProperty({ type: () => ProcurementSupplierRefDto })
  supplier!: ProcurementSupplierRefDto;

  @ApiProperty({ type: () => ProcurementRequestNoDto, nullable: true })
  request!: ProcurementRequestNoDto | null;

  @ApiProperty({ type: () => ProcurementLineCountDto })
  _count!: ProcurementLineCountDto;
}

export class ProcurementWarehouseRefDto extends PickType(WarehouseRow, ['id', 'code', 'nameAr'] as const) {}

export class ProcurementCostCenterRefDto extends PickType(CostCenterRow, ['id', 'code', 'nameAr'] as const) {}

export class ProcurementQuoteLineRefDto extends PickType(PurchaseQuoteLineRow, ['id', 'quoteId'] as const) {}

export class PurchaseOrderLineViewDto extends PurchaseOrderLineRow {
  @ApiProperty({ type: () => ProcurementItemRefDto })
  item!: ProcurementItemRefDto;

  @ApiProperty({ type: () => ProcurementItemUnitDto, nullable: true })
  itemUnit!: ProcurementItemUnitDto | null;

  @ApiProperty({ type: () => ProcurementRequestLineRefDto, nullable: true })
  requestLine!: ProcurementRequestLineRefDto | null;

  @ApiProperty({ type: () => ProcurementQuoteLineRefDto, nullable: true })
  quoteLine!: ProcurementQuoteLineRefDto | null;
}

export class PurchaseOrderDetailDto extends PurchaseOrderRow {
  @ApiProperty({ type: () => ProcurementSupplierDto })
  supplier!: ProcurementSupplierDto;

  @ApiProperty({ type: () => ProcurementWarehouseRefDto })
  warehouse!: ProcurementWarehouseRefDto;

  @ApiProperty({ type: () => ProcurementCostCenterRefDto, nullable: true })
  costCenter!: ProcurementCostCenterRefDto | null;

  @ApiProperty({ type: () => ProcurementRequestRefDto, nullable: true })
  request!: ProcurementRequestRefDto | null;

  @ApiProperty({ type: () => PurchaseOrderLineViewDto, isArray: true })
  lines!: PurchaseOrderLineViewDto[];
}

/** POST /purchase-requests/:id/convert: the draft orders created, one per supplier. */
export class ConvertedOrdersDto {
  @ApiProperty({ type: () => PurchaseOrderDetailDto, isArray: true })
  orders!: PurchaseOrderDetailDto[];
}

/** The member's role, with its names for the dialog. */
export class PurchaseDirectGapRoleDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** A member who creates or posts purchase invoices today without purchase.direct (ADR-025 §4). */
export class PurchaseDirectGapDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ type: 'string' })
  fullName!: string;

  @ApiProperty({ type: 'string' })
  email!: string;

  @ApiProperty({ type: 'string' })
  roleCode!: string;

  @ApiProperty({ type: () => PurchaseDirectGapRoleDto })
  role!: PurchaseDirectGapRoleDto;
}
