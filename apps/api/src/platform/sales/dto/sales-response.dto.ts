/**
 * Response shapes of the sales routes (PLAT-15). They describe what
 * SalesInvoicesService / SalesReturnsService return today; nothing here
 * changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  AccountRow,
  ItemRow,
  ItemUnitRow,
  JournalEntryRow,
  PartyRow,
  SalesInvoiceLineRow,
  SalesInvoiceRow,
  SalesReturnLineRow,
  SalesReturnRow,
  UnitRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';
import { EInvoiceStateDto } from '../../einvoice/dto/einvoice-response.dto.js';
import { PartyDto } from '../../parties/dto/parties-response.dto.js';

// ----------------------------------------------------------- shared refs

/** Customer summary on a sales list row (SalesInvoicesService.list, SalesReturnsService.list). */
export class SalesCustomerRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** Warehouse summary (invoice list, invoice and return detail). */
export class SalesWarehouseRefDto extends PickType(WarehouseRow, ['id', 'code', 'nameAr'] as const) {}

/** Cash account summary, null when the document is on credit. */
export class SalesCashAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr'] as const) {}

/** Journal entry summary of a document, null while it is a draft. */
export class SalesJournalRefDto extends PickType(JournalEntryRow, ['id', 'entryNo', 'status'] as const) {}

/** Unit summary of an item unit. */
export class SalesUnitRefDto extends PickType(UnitRow, ['id', 'code', 'nameAr'] as const) {}

/** Count of a document's lines (`_count` in the list rows). */
export class SalesLineCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

// ------------------------------------------------------- sales invoices

/** Item summary on an invoice line (SalesInvoicesService.get). */
export class SalesInvoiceItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'baseUnitId', 'itemKind'] as const) {}

/** An item unit with its unit (SalesInvoicesService.get). */
export class SalesInvoiceItemUnitDto extends ItemUnitRow {
  @ApiProperty({ type: () => SalesUnitRefDto })
  unit!: SalesUnitRefDto;
}

/** A sales invoice line: every column of `sales_invoice_lines` plus its item and item unit. */
export class SalesInvoiceLineViewDto extends SalesInvoiceLineRow {
  @ApiProperty({ type: () => SalesInvoiceItemRefDto })
  item!: SalesInvoiceItemRefDto;

  @ApiProperty({ type: () => SalesInvoiceItemUnitDto, nullable: true })
  itemUnit!: SalesInvoiceItemUnitDto | null;
}

/** A return that credits a sales invoice, as listed on the invoice detail. */
export class SalesInvoiceReturnRefDto extends PickType(SalesReturnRow, ['id', 'returnNo', 'status', 'grandTotal'] as const) {}

/** A sales invoice list row (SalesInvoicesService.list): customer, warehouse, line count and balance. */
export class SalesInvoiceListItemDto extends SalesInvoiceRow {
  @ApiProperty({ type: () => SalesCustomerRefDto })
  customer!: SalesCustomerRefDto;

  @ApiProperty({ type: () => SalesWarehouseRefDto })
  warehouse!: SalesWarehouseRefDto;

  @ApiProperty({ type: () => SalesLineCountDto })
  _count!: SalesLineCountDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  creditedAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outstanding!: string;
}

/** A sales invoice with its lines, customer, journal entry, returns and e-invoice state (SalesInvoicesService.get). */
export class SalesInvoiceDetailDto extends SalesInvoiceRow {
  @ApiProperty({ type: () => PartyDto })
  customer!: PartyDto;

  @ApiProperty({ type: () => WarehouseRow })
  warehouse!: WarehouseRow;

  @ApiProperty({ type: () => SalesCashAccountRefDto, nullable: true })
  cashAccount!: SalesCashAccountRefDto | null;

  @ApiProperty({ type: () => SalesInvoiceLineViewDto, isArray: true })
  lines!: SalesInvoiceLineViewDto[];

  @ApiProperty({ type: () => SalesJournalRefDto, nullable: true })
  journalEntry!: SalesJournalRefDto | null;

  @ApiProperty({ type: () => SalesInvoiceReturnRefDto, isArray: true })
  returns!: SalesInvoiceReturnRefDto[];

  @ApiProperty({ type: 'string', format: 'decimal' })
  creditedAmount!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outstanding!: string;

  @ApiProperty({ type: () => EInvoiceStateDto, nullable: true, description: 'Null when the invoice was never queued for e-invoicing.' })
  einvoice!: EInvoiceStateDto | null;
}

// -------------------------------------------------------- sales returns

/** Original invoice summary on a return list row. */
export class SalesReturnOriginalInvoiceRefDto extends PickType(SalesInvoiceRow, ['id', 'invoiceNo'] as const) {}

/** Original invoice summary on a return detail. */
export class SalesReturnOriginalInvoiceDetailDto extends PickType(SalesInvoiceRow, ['id', 'invoiceNo', 'invoiceDate'] as const) {}

/** Item summary on a return line. */
export class SalesReturnItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr'] as const) {}

/** Unit name of the invoice line a return line refers to. */
export class SalesReturnUnitNameDto extends PickType(UnitRow, ['nameAr'] as const) {}

/** Item unit of the original invoice line, carrying only the unit name. */
export class SalesReturnOriginalLineItemUnitDto {
  @ApiProperty({ type: () => SalesReturnUnitNameDto })
  unit!: SalesReturnUnitNameDto;
}

/** The original invoice line a return line refers to. */
export class SalesReturnOriginalLineDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  @ApiProperty({ type: () => SalesReturnOriginalLineItemUnitDto, nullable: true })
  itemUnit!: SalesReturnOriginalLineItemUnitDto | null;
}

/** A sales return line: every column of `sales_return_lines` plus its item and original line. */
export class SalesReturnLineViewDto extends SalesReturnLineRow {
  @ApiProperty({ type: () => SalesReturnItemRefDto })
  item!: SalesReturnItemRefDto;

  @ApiProperty({ type: () => SalesReturnOriginalLineDto })
  originalLine!: SalesReturnOriginalLineDto;
}

/** A sales return list row (SalesReturnsService.list). */
export class SalesReturnListItemDto extends SalesReturnRow {
  @ApiProperty({ type: () => SalesCustomerRefDto })
  customer!: SalesCustomerRefDto;

  @ApiProperty({ type: () => SalesReturnOriginalInvoiceRefDto })
  originalInvoice!: SalesReturnOriginalInvoiceRefDto;

  @ApiProperty({ type: () => SalesLineCountDto })
  _count!: SalesLineCountDto;
}

/** A sales return with its lines, original invoice, journal entry and e-invoice state (SalesReturnsService.get). */
export class SalesReturnDetailDto extends SalesReturnRow {
  @ApiProperty({ type: () => PartyDto })
  customer!: PartyDto;

  @ApiProperty({ type: () => SalesReturnOriginalInvoiceDetailDto })
  originalInvoice!: SalesReturnOriginalInvoiceDetailDto;

  @ApiProperty({ type: () => SalesWarehouseRefDto })
  warehouse!: SalesWarehouseRefDto;

  @ApiProperty({ type: () => SalesCashAccountRefDto, nullable: true })
  cashAccount!: SalesCashAccountRefDto | null;

  @ApiProperty({ type: () => SalesReturnLineViewDto, isArray: true })
  lines!: SalesReturnLineViewDto[];

  @ApiProperty({ type: () => SalesJournalRefDto, nullable: true })
  journalEntry!: SalesJournalRefDto | null;

  @ApiProperty({ type: () => EInvoiceStateDto, nullable: true, description: 'Null when the return was never queued for e-invoicing.' })
  einvoice!: EInvoiceStateDto | null;
}
