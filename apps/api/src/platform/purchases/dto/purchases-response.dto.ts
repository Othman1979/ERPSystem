/**
 * Response shapes of the purchase routes (PLAT-15). They describe what
 * PurchaseInvoicesService / PurchaseReturnsService return today; nothing here
 * changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  AccountRow,
  GoodsNoteRow,
  ItemRow,
  ItemUnitRow,
  JournalEntryRow,
  PartyRow,
  PurchaseInvoiceLineRow,
  PurchaseInvoiceReceiptRow,
  PurchaseInvoiceRow,
  PurchaseOrderRow,
  PurchaseReturnLineRow,
  PurchaseReturnRow,
  UnitRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';
import { PartyDto } from '../../parties/dto/parties-response.dto.js';

// ----------------------------------------------------------- shared refs

/** Supplier summary on a purchase list row (PurchaseInvoicesService.list, PurchaseReturnsService.list). */
export class PurchaseSupplierRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** Warehouse summary (invoice detail, return detail). */
export class PurchaseWarehouseRefDto extends PickType(WarehouseRow, ['id', 'code', 'nameAr'] as const) {}

/** Cash account summary, null when the document is on credit. */
export class PurchaseCashAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr'] as const) {}

/** Journal entry summary of a document, null while it is a draft. */
export class PurchaseJournalRefDto extends PickType(JournalEntryRow, ['id', 'entryNo', 'status'] as const) {}

/** Unit summary of an item unit. */
export class PurchaseUnitRefDto extends PickType(UnitRow, ['id', 'code', 'nameAr'] as const) {}

/** Count of a document's lines (`_count` in the list rows). */
export class PurchaseLineCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

// ----------------------------------------------------- purchase invoices

/** Item summary on an invoice line (PurchaseInvoicesService.get). */
export class PurchaseInvoiceItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'baseUnitId', 'itemKind'] as const) {}

/** An item unit with its unit (PurchaseInvoicesService.get). */
export class PurchaseInvoiceItemUnitDto extends ItemUnitRow {
  @ApiProperty({ type: () => PurchaseUnitRefDto })
  unit!: PurchaseUnitRefDto;
}

/** ADR-026 §7: the GRN line an invoice line bills, its base quantity and the value cleared from 2104 (null on a draft). */
export class PurchaseInvoiceReceiptLinkDto extends PickType(PurchaseInvoiceReceiptRow, ['id', 'grnLineId', 'qty', 'clearedValue'] as const) {}

/** A purchase invoice line: every column of `purchase_invoice_lines` plus its item, item unit and receipt links. */
export class PurchaseInvoiceLineViewDto extends PurchaseInvoiceLineRow {
  @ApiProperty({ type: () => PurchaseInvoiceItemRefDto })
  item!: PurchaseInvoiceItemRefDto;

  @ApiProperty({ type: () => PurchaseInvoiceItemUnitDto, nullable: true })
  itemUnit!: PurchaseInvoiceItemUnitDto | null;

  @ApiProperty({ type: () => PurchaseInvoiceReceiptLinkDto, isArray: true })
  receipts!: PurchaseInvoiceReceiptLinkDto[];
}

/** An invoice line priced above its order line: the net prices per base unit compared (ADR-026 §2). */
export class PriceAboveOrderLineDto {
  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string' })
  grnLineId!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  invoiceNetUnitPrice!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  orderNetUnitPrice!: string;
}

/** The purchase order an invoice bills (ADR-026 §7). */
export class PurchaseInvoiceOrderRefDto extends PickType(PurchaseOrderRow, ['id', 'orderNo', 'status'] as const) {}

/** A return that credits a purchase invoice, as listed on the invoice detail. */
export class PurchaseInvoiceReturnRefDto extends PickType(PurchaseReturnRow, ['id', 'returnNo', 'status', 'grandTotal'] as const) {}

/** The goods receipt a purchase invoice was matched to. */
export class PurchaseInvoiceGoodsNoteRefDto extends PickType(GoodsNoteRow, ['id', 'docNo', 'noteDate'] as const) {}

/** A purchase invoice list row (PurchaseInvoicesService.list): supplier, line count and balance. */
export class PurchaseInvoiceListItemDto extends PurchaseInvoiceRow {
  @ApiProperty({ type: () => PurchaseSupplierRefDto })
  supplier!: PurchaseSupplierRefDto;

  @ApiProperty({ type: () => PurchaseLineCountDto })
  _count!: PurchaseLineCountDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  creditedAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outstanding!: string;
}

/** A purchase invoice with its lines, supplier, journal entry, returns and matched receipt (PurchaseInvoicesService.get). */
export class PurchaseInvoiceDetailDto extends PurchaseInvoiceRow {
  @ApiProperty({ type: () => PartyDto })
  supplier!: PartyDto;

  @ApiProperty({ type: () => PurchaseWarehouseRefDto, nullable: true })
  warehouse!: PurchaseWarehouseRefDto | null;

  @ApiProperty({ type: () => PurchaseCashAccountRefDto, nullable: true })
  cashAccount!: PurchaseCashAccountRefDto | null;

  @ApiProperty({ type: () => PurchaseInvoiceLineViewDto, isArray: true })
  lines!: PurchaseInvoiceLineViewDto[];

  @ApiProperty({ type: () => PurchaseJournalRefDto, nullable: true })
  journalEntry!: PurchaseJournalRefDto | null;

  @ApiProperty({ type: () => PurchaseInvoiceReturnRefDto, isArray: true })
  returns!: PurchaseInvoiceReturnRefDto[];

  @ApiProperty({ type: () => PurchaseInvoiceGoodsNoteRefDto, nullable: true })
  receivedGrn!: PurchaseInvoiceGoodsNoteRefDto | null;

  @ApiProperty({ type: () => PurchaseInvoiceOrderRefDto, nullable: true })
  purchaseOrder!: PurchaseInvoiceOrderRefDto | null;

  /** ADR-026 §2: on a draft on an order, the lines priced above the order (empty otherwise). */
  @ApiProperty({ type: () => PriceAboveOrderLineDto, isArray: true })
  priceAboveOrderLines!: PriceAboveOrderLineDto[];

  @ApiProperty({ type: 'string', format: 'decimal' })
  creditedAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outstanding!: string;
}

// ------------------------------------------- billing an order (ADR-026 §7)

/** An item on the «billable» view: id, code and names. */
export class BillableItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** One posted GRN line of the order, with what it received and billed and the prices to bill it at. */
export class BillableLineDto {
  @ApiProperty({ type: 'string' })
  grnLineId!: string;

  @ApiProperty({ type: 'string' })
  grnId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  grnDocNo!: string | null;

  @ApiProperty({ type: () => BillableItemRefDto })
  item!: BillableItemRefDto;

  @ApiProperty({ type: 'string', nullable: true })
  poLineId!: string | null;

  @ApiProperty({ type: 'integer', nullable: true })
  poLineNo!: number | null;

  /** Base quantities. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  receivedQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  billedQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unbilledQty!: string;

  /** The receipt cost per base unit (the order's net price, ADR-026 §5). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  receiptUnitCost!: string;

  /** The order line's price per its unit, and discount. */
  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  orderUnitPrice!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  orderDiscountPct!: string | null;

  /** The order's net price per base unit (6 dp): what an invoice price is compared with (ADR-026 §2). */
  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  orderNetUnitPrice!: string | null;

  /** The invoice price per base unit to suggest: the order's, on the company's tax basis, never above it. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  defaultUnitCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  defaultDiscountPct!: string;

  @ApiProperty({ type: 'string', nullable: true })
  taxCategoryId!: string | null;

  /** The order line's tax rate in percent, to compare a tax-inclusive price net of tax. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  taxRate!: string;
}

/** GET /purchase-orders/:id/billable: the order and its posted GRN lines. */
export class PurchaseOrderBillableDto {
  @ApiProperty({ type: 'string' })
  orderId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  orderNo!: string | null;

  @ApiProperty({ type: 'string' })
  status!: string;

  @ApiProperty({ type: 'string' })
  supplierId!: string;

  @ApiProperty({ type: 'string' })
  warehouseId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  costCenterId!: string | null;

  /** The order's prices include tax (frozen on the order). */
  @ApiProperty({ type: 'boolean' })
  orderPricesIncludeTax!: boolean;

  /** The company's current setting: an invoice is priced on it (ADR-017). */
  @ApiProperty({ type: 'boolean' })
  pricesIncludeTax!: boolean;

  @ApiProperty({ type: () => BillableLineDto, isArray: true })
  lines!: BillableLineDto[];
}

// ----------------------------------------------------- purchase returns

/** Original invoice summary on a return list row. */
export class PurchaseReturnOriginalInvoiceRefDto extends PickType(PurchaseInvoiceRow, ['id', 'invoiceNo'] as const) {}

/** Original invoice summary on a return detail. */
export class PurchaseReturnOriginalInvoiceDetailDto extends PickType(PurchaseInvoiceRow, ['id', 'invoiceNo', 'invoiceDate'] as const) {}

/** Item summary on a return line. */
export class PurchaseReturnItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr'] as const) {}

/** The original invoice line a return line refers to. */
export class PurchaseReturnOriginalLineDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;
}

/** A purchase return line: every column of `purchase_return_lines` plus its item and original line. */
export class PurchaseReturnLineViewDto extends PurchaseReturnLineRow {
  @ApiProperty({ type: () => PurchaseReturnItemRefDto })
  item!: PurchaseReturnItemRefDto;

  @ApiProperty({ type: () => PurchaseReturnOriginalLineDto })
  originalLine!: PurchaseReturnOriginalLineDto;
}

/** A purchase return list row (PurchaseReturnsService.list). */
export class PurchaseReturnListItemDto extends PurchaseReturnRow {
  @ApiProperty({ type: () => PurchaseSupplierRefDto })
  supplier!: PurchaseSupplierRefDto;

  @ApiProperty({ type: () => PurchaseReturnOriginalInvoiceRefDto })
  originalInvoice!: PurchaseReturnOriginalInvoiceRefDto;

  @ApiProperty({ type: () => PurchaseLineCountDto })
  _count!: PurchaseLineCountDto;
}

/** A purchase return with its lines, original invoice and journal entry (PurchaseReturnsService.get). */
export class PurchaseReturnDetailDto extends PurchaseReturnRow {
  @ApiProperty({ type: () => PartyDto })
  supplier!: PartyDto;

  @ApiProperty({ type: () => PurchaseReturnOriginalInvoiceDetailDto })
  originalInvoice!: PurchaseReturnOriginalInvoiceDetailDto;

  /** Null for the return of a service-only invoice (ADR-016 §5). */
  @ApiProperty({ type: () => PurchaseWarehouseRefDto, nullable: true })
  warehouse!: PurchaseWarehouseRefDto | null;

  @ApiProperty({ type: () => PurchaseCashAccountRefDto, nullable: true })
  cashAccount!: PurchaseCashAccountRefDto | null;

  @ApiProperty({ type: () => PurchaseReturnLineViewDto, isArray: true })
  lines!: PurchaseReturnLineViewDto[];

  @ApiProperty({ type: () => PurchaseJournalRefDto, nullable: true })
  journalEntry!: PurchaseJournalRefDto | null;
}
