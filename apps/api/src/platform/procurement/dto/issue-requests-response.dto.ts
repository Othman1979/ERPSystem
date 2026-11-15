/**
 * Response shapes of the issue request routes (ADR-026 §9, ADR-023). They
 * describe what IssueRequestsService returns; nothing here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import { AccountRow, IssueRequestLineRow, IssueRequestRow } from '../../../common/openapi/prisma-models.js';
import {
  ProcurementCostCenterRefDto,
  ProcurementItemRefDto,
  ProcurementLineCountDto,
  ProcurementWarehouseRefDto,
} from './procurement-response.dto.js';

/** The expense account an issue request's issues debit. */
export class IssueRequestAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr'] as const) {}

/** An issue request in the list, with its warehouse, department and line count. */
export class IssueRequestListItemDto extends IssueRequestRow {
  @ApiProperty({ type: () => ProcurementWarehouseRefDto })
  warehouse!: ProcurementWarehouseRefDto;

  @ApiProperty({ type: () => ProcurementCostCenterRefDto, nullable: true })
  costCenter!: ProcurementCostCenterRefDto | null;

  @ApiProperty({ type: () => ProcurementLineCountDto })
  _count!: ProcurementLineCountDto;
}

/** A requested item with what is left to issue (base units). */
export class IssueRequestLineViewDto extends IssueRequestLineRow {
  @ApiProperty({ type: () => ProcurementItemRefDto })
  item!: ProcurementItemRefDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  remainingQty!: string;
}

/** One issue request with its warehouse, department, expense account and lines. */
export class IssueRequestDetailDto extends IssueRequestRow {
  @ApiProperty({ type: () => ProcurementWarehouseRefDto })
  warehouse!: ProcurementWarehouseRefDto;

  @ApiProperty({ type: () => ProcurementCostCenterRefDto, nullable: true })
  costCenter!: ProcurementCostCenterRefDto | null;

  @ApiProperty({ type: () => IssueRequestAccountRefDto, nullable: true })
  expenseAccount!: IssueRequestAccountRefDto | null;

  @ApiProperty({ type: () => IssueRequestLineViewDto, isArray: true })
  lines!: IssueRequestLineViewDto[];
}
