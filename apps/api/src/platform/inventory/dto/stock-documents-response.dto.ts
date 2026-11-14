/**
 * Response shapes of the stock-documents routes (PLAT-15): stock adjustments,
 * stock transfers and stock counts. They describe what the services return
 * today (AdjustmentsService, TransfersService, CountsService); nothing here
 * changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  ItemRow,
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

/** A line of a count, with its item (CountsService.get). */
export class StockCountLineDto extends StockCountLineRow {
  @ApiProperty({ type: () => StockDocumentItemBaseUnitRefDto })
  item!: StockDocumentItemBaseUnitRefDto;
}

/**
 * One stock count with its warehouse and lines (CountsService.get). Mirrors
 * create, get, refresh and approve, which all return it.
 */
export class StockCountDetailDto extends StockCountRow {
  @ApiProperty({ type: () => StockDocumentWarehouseDto })
  warehouse!: StockDocumentWarehouseDto;

  @ApiProperty({ type: () => StockCountLineDto, isArray: true })
  lines!: StockCountLineDto[];
}
