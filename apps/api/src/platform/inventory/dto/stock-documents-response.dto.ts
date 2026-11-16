/**
 * Response shapes of the stock-documents routes (PLAT-15): stock adjustments,
 * stock transfers and stock counts. They describe what the services return
 * today (AdjustmentsService, TransfersService, CountsService); nothing here
 * changes a body.
 */
import { ApiProperty, OmitType, PickType } from '@nestjs/swagger';
import {
  ItemRow,
  ItemUnitRow,
  JournalEntryRow,
  StockAdjustmentLineRow,
  StockAdjustmentRow,
  StockCountLineRow,
  StockCountRow,
  StockTransferLineRow,
  StockTransferRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';

// ------------------------------------------------------------- shared refs

/** A warehouse as a list row selects it: `{ id, code, nameAr }` (AdjustmentsService.list and friends). */
export class StockDocumentWarehouseRefDto extends PickType(WarehouseRow, ['id', 'code', 'nameAr'] as const) {}

/** A whole warehouse row, as a document detail includes it (`warehouse: true`). */
export class StockDocumentWarehouseDto extends WarehouseRow {}

/** An item as a transfer line selects it: `{ id, code, nameAr }` (TransfersService.get). */
export class StockDocumentItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr'] as const) {}

/** An item as an adjustment or count line selects it, with its base unit id (AdjustmentsService.get, CountsService.get). */
export class StockDocumentItemBaseUnitRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'baseUnitId'] as const) {}

/** The `_count` of a document list row: how many lines it has. */
export class StockDocumentLineCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

// ------------------------------------------------------------- adjustments

/** Row of GET /stock-adjustments (AdjustmentsService.list): the adjustment with its warehouse and line count. */
export class StockAdjustmentListItemDto extends StockAdjustmentRow {
  @ApiProperty({ type: () => StockDocumentWarehouseRefDto })
  warehouse!: StockDocumentWarehouseRefDto;

  @ApiProperty({ type: () => StockDocumentLineCountDto })
  _count!: StockDocumentLineCountDto;
}

/** The journal entry of a posted adjustment, as the detail selects it (`{ id, entryNo }`). */
export class StockAdjustmentJournalEntryRefDto extends PickType(JournalEntryRow, ['id', 'entryNo'] as const) {}

/** A reference to another adjustment, `{ id, docNo }` (reversalOf). */
export class StockAdjustmentRefDto extends PickType(StockAdjustmentRow, ['id', 'docNo'] as const) {}

/** A reversal of an adjustment, `{ id, docNo, status }` (reversals). */
export class StockAdjustmentReversalDto extends PickType(StockAdjustmentRow, ['id', 'docNo', 'status'] as const) {}

/** A line of an adjustment, with its item (AdjustmentsService.get). */
export class StockAdjustmentLineDto extends StockAdjustmentLineRow {
  @ApiProperty({ type: () => StockDocumentItemBaseUnitRefDto })
  item!: StockDocumentItemBaseUnitRefDto;
}

/**
 * One stock adjustment with its warehouse, lines, journal and reversal links
 * (AdjustmentsService.get). Mirrors create, get, post and reverse, which all
 * return it.
 */
export class StockAdjustmentDetailDto extends StockAdjustmentRow {
  @ApiProperty({ type: () => StockDocumentWarehouseDto })
  warehouse!: StockDocumentWarehouseDto;

  @ApiProperty({ type: () => StockAdjustmentLineDto, isArray: true })
  lines!: StockAdjustmentLineDto[];

  @ApiProperty({ type: () => StockAdjustmentJournalEntryRefDto, nullable: true })
  journalEntry!: StockAdjustmentJournalEntryRefDto | null;

  @ApiProperty({ type: () => StockAdjustmentRefDto, nullable: true })
  reversalOf!: StockAdjustmentRefDto | null;

  @ApiProperty({ type: () => StockAdjustmentReversalDto, isArray: true })
  reversals!: StockAdjustmentReversalDto[];
}

// --------------------------------------------------------------- transfers

/** Row of GET /stock-transfers (TransfersService.list): the transfer with both warehouses and its line count. */
export class StockTransferListItemDto extends StockTransferRow {
  @ApiProperty({ type: () => StockDocumentWarehouseRefDto })
  fromWarehouse!: StockDocumentWarehouseRefDto;

  @ApiProperty({ type: () => StockDocumentWarehouseRefDto })
  toWarehouse!: StockDocumentWarehouseRefDto;

  @ApiProperty({ type: () => StockDocumentLineCountDto })
  _count!: StockDocumentLineCountDto;
}

/** A reference to another transfer, `{ id, docNo }` (reversalOf). */
export class StockTransferRefDto extends PickType(StockTransferRow, ['id', 'docNo'] as const) {}

/** A reversal of a transfer, `{ id, docNo, status }` (reversals). */
export class StockTransferReversalDto extends PickType(StockTransferRow, ['id', 'docNo', 'status'] as const) {}

/** A line of a transfer, with its item (TransfersService.get). */
export class StockTransferLineDto extends StockTransferLineRow {
  @ApiProperty({ type: () => StockDocumentItemRefDto })
  item!: StockDocumentItemRefDto;
}

/**
 * One stock transfer with both warehouses, lines and reversal links
 * (TransfersService.get). Mirrors create, get, post and reverse.
 */
export class StockTransferDetailDto extends StockTransferRow {
  @ApiProperty({ type: () => StockDocumentWarehouseDto })
  fromWarehouse!: StockDocumentWarehouseDto;

  @ApiProperty({ type: () => StockDocumentWarehouseDto })
  toWarehouse!: StockDocumentWarehouseDto;

  @ApiProperty({ type: () => StockTransferLineDto, isArray: true })
  lines!: StockTransferLineDto[];

  @ApiProperty({ type: () => StockTransferRefDto, nullable: true })
  reversalOf!: StockTransferRefDto | null;

  @ApiProperty({ type: () => StockTransferReversalDto, isArray: true })
  reversals!: StockTransferReversalDto[];
}

// ------------------------------------------------------------------ counts

/** Row of GET /stock-counts (CountsService.list): the count with its warehouse and line count. */
export class StockCountListItemDto extends StockCountRow {
  @ApiProperty({ type: () => StockDocumentWarehouseRefDto })
  warehouse!: StockDocumentWarehouseRefDto;

  @ApiProperty({ type: () => StockDocumentLineCountDto })
  _count!: StockDocumentLineCountDto;
}

/** A unit as a count selects it: `{ code, nameAr }`. */
export class StockDocumentUnitRefDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;
}

/** The unit a counter entered a line in, with its unit code (null on a line counted in the base unit). */
export class StockCountItemUnitDto extends ItemUnitRow {
  @ApiProperty({ type: () => StockDocumentUnitRefDto })
  unit!: StockDocumentUnitRefDto;
}

/**
 * A count line. The book qty and the difference are null while the count is a
 * blind DRAFT (ADR-030 §6), for everyone, the owner included.
 */
export class StockCountLineDto extends OmitType(StockCountLineRow, ['systemQty', 'differenceQty'] as const) {
  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  systemQty!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  differenceQty!: string | null;

  @ApiProperty({ type: () => StockDocumentItemBaseUnitRefDto })
  item!: StockDocumentItemBaseUnitRefDto;

  @ApiProperty({ type: () => StockCountItemUnitDto, nullable: true })
  itemUnit!: StockCountItemUnitDto | null;
}

/**
 * One stock count with its warehouse and lines (CountsService.get). Mirrors
 * create, get, refresh, submit, reopen, approve and the import, which all return it.
 */
export class StockCountDetailDto extends StockCountRow {
  @ApiProperty({ type: () => StockDocumentWarehouseDto })
  warehouse!: StockDocumentWarehouseDto;

  @ApiProperty({ type: () => StockCountLineDto, isArray: true })
  lines!: StockCountLineDto[];

  /** The users who entered quantities on this count (ADR-030 §3): none of them may approve it. */
  @ApiProperty({ type: 'string', isArray: true })
  counterIds!: string[];
}

/** The sheet of a count (CountsService.sheet): the rows to count, the book only when it is shown. */
export class StockCountSheetRowDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string', nullable: true })
  barcode!: string | null;

  @ApiProperty({ type: 'string' })
  name!: string;

  @ApiProperty({ type: 'string' })
  unit!: string;

  /** The book qty at the count date; absent while the count is a blind draft. */
  @ApiProperty({ type: 'string', format: 'decimal', required: false })
  bookQty?: string;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  countedQty!: string | null;
}

/** A warehouse as a sheet or variance names it: `{ code, nameAr }`. */
export class StockCountWarehouseRefDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;
}

export class StockCountSheetDto {
  @ApiProperty({ type: 'string' })
  countId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  docNo!: string | null;

  @ApiProperty({ type: 'string', enum: ['DRAFT', 'SUBMITTED', 'POSTED'] })
  status!: string;

  @ApiProperty({ type: () => StockCountWarehouseRefDto })
  warehouse!: StockCountWarehouseRefDto;

  @ApiProperty({ type: 'string', format: 'date' })
  countDate!: string;

  @ApiProperty({ type: 'boolean' })
  bookHidden!: boolean;

  @ApiProperty({ type: () => StockCountSheetRowDto, isArray: true })
  rows!: StockCountSheetRowDto[];
}

/** A counted line of the difference report (CountsService.variance). */
export class StockCountVarianceLineDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string' })
  unit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  bookQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  countedQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  differenceQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unitCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  differenceValue!: string;

  @ApiProperty({ type: 'boolean' })
  zeroCostGain!: boolean;
}

export class StockCountUncountedLineDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;
}

/** Totals of the difference report: shortages (negative), surpluses (positive) and the net value. */
export class StockCountVarianceTotalsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  shortageQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  surplusQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  shortageValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  surplusValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  netValue!: string;

  @ApiProperty({ type: 'integer' })
  countedLines!: number;

  @ApiProperty({ type: 'integer' })
  uncountedLines!: number;
}

export class StockCountVarianceDto {
  @ApiProperty({ type: 'string' })
  countId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  docNo!: string | null;

  @ApiProperty({ type: 'string', enum: ['DRAFT', 'SUBMITTED', 'POSTED'] })
  status!: string;

  @ApiProperty({ type: () => StockCountWarehouseRefDto })
  warehouse!: StockCountWarehouseRefDto;

  @ApiProperty({ type: 'string', format: 'date' })
  countDate!: string;

  @ApiProperty({ type: () => StockCountVarianceLineDto, isArray: true })
  lines!: StockCountVarianceLineDto[];

  @ApiProperty({ type: () => StockCountUncountedLineDto, isArray: true })
  uncounted!: StockCountUncountedLineDto[];

  @ApiProperty({ type: () => StockCountVarianceTotalsDto })
  totals!: StockCountVarianceTotalsDto;
}
