/**
 * Response shapes of the goods-note routes (PLAT-15). They describe what
 * GoodsNotesService returns today; nothing here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  GoodsNoteLineRow,
  GoodsNoteRow,
  ItemRow,
  JournalEntryRow,
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

/** One goods note with its warehouse, branch, lines and journal entry (GoodsNotesService.get; also create, update and post). */
export class GoodsNoteDetailDto extends GoodsNoteRow {
  @ApiProperty({ type: () => WarehouseRow })
  warehouse!: WarehouseRow;

  @ApiProperty({ type: () => BranchRefDto, nullable: true })
  branch!: BranchRefDto | null;

  @ApiProperty({ type: () => GoodsNoteLineWithItemDto, isArray: true })
  lines!: GoodsNoteLineWithItemDto[];

  @ApiProperty({ type: () => GoodsNoteJournalEntryRefDto, nullable: true })
  journalEntry!: GoodsNoteJournalEntryRefDto | null;
}
