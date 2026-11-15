/**
 * Response shapes of the goods-note routes (PLAT-15). They describe what
 * GoodsNotesService returns today; nothing here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  AccountRow,
  CostCenterRow,
  GoodsNoteLineRow,
  GoodsNoteRow,
  IssueRequestRow,
  ItemRow,
  JournalEntryRow,
  PartyRow,
  PurchaseOrderRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';
import { BranchRefDto, WarehouseRefDto } from '../../inventory/dto/inventory-response.dto.js';

/** `_count` of a goods note: its lines. */
export class GoodsNoteCountDto {
  @ApiProperty({ type: 'integer' })
  lines!: number;
}

/** A goods note in the list: every column, with its warehouse, branch and line count (GoodsNotesService.list). */
export class GoodsNoteListItemDto extends GoodsNoteRow {
  @ApiProperty({ type: () => WarehouseRefDto })
  warehouse!: WarehouseRefDto;

  @ApiProperty({ type: () => BranchRefDto, nullable: true })
  branch!: BranchRefDto | null;

  @ApiProperty({ type: () => GoodsNoteCountDto })
  _count!: GoodsNoteCountDto;
}

/** The item of a goods note line: id, code and Arabic name. */
export class GoodsNoteItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr'] as const) {}

/** A goods note line with its item (GoodsNoteLine + item). */
export class GoodsNoteLineWithItemDto extends GoodsNoteLineRow {
  @ApiProperty({ type: () => GoodsNoteItemRefDto })
  item!: GoodsNoteItemRefDto;
}

/** The journal entry a posted goods note created: id, number and status. */
export class GoodsNoteJournalEntryRefDto extends PickType(JournalEntryRow, ['id', 'entryNo', 'status'] as const) {}

/** The purchase order a GRN receives against (ADR-026 §5). */
export class GoodsNoteOrderRefDto extends PickType(PurchaseOrderRow, ['id', 'orderNo', 'status'] as const) {}

/** The issue request a GIN issues from (ADR-026 §9). */
export class GoodsNoteIssueRequestRefDto extends PickType(IssueRequestRow, ['id', 'requestNo', 'status'] as const) {}

/** The supplier of a GRN against an order. */
export class GoodsNoteSupplierRefDto extends PickType(PartyRow, ['id', 'code', 'nameAr'] as const) {}

/** The expense account of a GIN to a department (ADR-026 §8). */
export class GoodsNoteAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr'] as const) {}

/** The department (cost centre) of a GIN. */
export class GoodsNoteCostCenterRefDto extends PickType(CostCenterRow, ['id', 'code', 'nameAr'] as const) {}

/** One goods note with its warehouse, branch, lines and journal entry (GoodsNotesService.get; also create, update and post). */
export class GoodsNoteDetailDto extends GoodsNoteRow {
  @ApiProperty({ type: () => GoodsNoteOrderRefDto, nullable: true })
  purchaseOrder!: GoodsNoteOrderRefDto | null;

  @ApiProperty({ type: () => GoodsNoteSupplierRefDto, nullable: true })
  supplier!: GoodsNoteSupplierRefDto | null;

  @ApiProperty({ type: () => GoodsNoteAccountRefDto, nullable: true })
  expenseAccount!: GoodsNoteAccountRefDto | null;

  @ApiProperty({ type: () => GoodsNoteCostCenterRefDto, nullable: true })
  costCenter!: GoodsNoteCostCenterRefDto | null;

  @ApiProperty({ type: () => GoodsNoteIssueRequestRefDto, nullable: true })
  issueRequest!: GoodsNoteIssueRequestRefDto | null;

  @ApiProperty({ type: () => WarehouseRow })
  warehouse!: WarehouseRow;

  @ApiProperty({ type: () => BranchRefDto, nullable: true })
  branch!: BranchRefDto | null;

  @ApiProperty({ type: () => GoodsNoteLineWithItemDto, isArray: true })
  lines!: GoodsNoteLineWithItemDto[];

  @ApiProperty({ type: () => GoodsNoteJournalEntryRefDto, nullable: true })
  journalEntry!: GoodsNoteJournalEntryRefDto | null;
}
