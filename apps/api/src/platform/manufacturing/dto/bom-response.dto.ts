/**
 * Response shapes of the bill-of-materials routes (ADR-023): what BomService
 * returns. Ids, quantities and amounts are strings (CLAUDE.md).
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import { BomLineRow, BomRow, ItemRow, ItemUnitRow, UnitRow } from '../../../common/openapi/prisma-models.js';

export class BomUnitRefDto extends PickType(UnitRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

export class BomItemRefDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'nameEn', 'itemKind'] as const) {
  @ApiProperty({ type: () => BomUnitRefDto })
  baseUnit!: BomUnitRefDto;
}

export class BomItemUnitRefDto extends PickType(ItemUnitRow, ['id', 'factorToBase'] as const) {
  @ApiProperty({ type: () => BomUnitRefDto })
  unit!: BomUnitRefDto;
}

/** One version in a list page (ADR-022). */
export class BomListItemDto extends PickType(BomRow, [
  'id',
  'itemId',
  'versionNo',
  'status',
  'outputQty',
  'outputQtyBase',
  'appliedCostPerUnit',
  'activatedAt',
  'createdAt',
  'updatedAt',
] as const) {
  @ApiProperty({ type: () => BomItemRefDto })
  item!: BomItemRefDto;

  /** Null when the output is in the base unit. */
  @ApiProperty({ type: () => BomItemUnitRefDto, nullable: true })
  outputItemUnit!: BomItemUnitRefDto | null;

  @ApiProperty({ type: 'integer' })
  lineCount!: number;
}

export class BomLineDetailDto extends PickType(BomLineRow, [
  'id',
  'lineNo',
  'componentItemId',
  'qty',
  'qtyBase',
  'wastePct',
  'note',
] as const) {
  @ApiProperty({ type: () => BomItemRefDto })
  componentItem!: BomItemRefDto;

  /** Null when the component is counted in its base unit. */
  @ApiProperty({ type: () => BomItemUnitRefDto, nullable: true })
  itemUnit!: BomItemUnitRefDto | null;
}

/** One version with its components (get, create, update, copy, activate, deactivate). */
export class BomDetailDto extends PickType(BomRow, [
  'id',
  'itemId',
  'versionNo',
  'status',
  'outputQty',
  'outputItemUnitId',
  'outputQtyBase',
  'appliedCostPerUnit',
  'note',
  'activatedAt',
  'activatedBy',
  'createdAt',
  'updatedAt',
] as const) {
  @ApiProperty({ type: () => BomItemRefDto })
  item!: BomItemRefDto;

  /** Null when the output is in the base unit. */
  @ApiProperty({ type: () => BomItemUnitRefDto, nullable: true })
  outputItemUnit!: BomItemUnitRefDto | null;

  @ApiProperty({ type: () => [BomLineDetailDto] })
  lines!: BomLineDetailDto[];
}

export class BomRequirementLineDto {
  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string' })
  componentItemId!: string;

  @ApiProperty({ type: () => BomItemRefDto })
  componentItem!: BomItemRefDto;

  /** Waste percentage of the line (4 dp). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  wastePct!: string;

  /** The line's base quantity per output batch, before scaling. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  /** The standard requirement for the requested quantity, in the base unit (6 dp). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  requiredQtyBase!: string;
}

/** Standard requirements for a quantity of the output (one level, ADR-031 §6). */
export class BomRequirementsDto {
  @ApiProperty({ type: 'string' })
  bomId!: string;

  @ApiProperty({ type: 'integer' })
  versionNo!: number;

  /** The requested quantity, in the BOM's output unit, as sent. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outputQtyBase!: string;

  @ApiProperty({ type: () => [BomRequirementLineDto] })
  lines!: BomRequirementLineDto[];
}

/** One stock leaf of a cost card: its quantity for one output unit and its average cost (ADR-032 §4). */
export class BomCostLineDto {
  @ApiProperty({ type: 'string' })
  componentItemId!: string;

  @ApiProperty({ type: () => BomItemRefDto })
  componentItem!: BomItemRefDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  /** The item's current average cost per base unit (6 dp). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  avgCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalCost!: string;

  /** True when the component has no cost yet (an opening or receipt at zero): the cost is understated. */
  @ApiProperty({ type: 'boolean' })
  zeroCost!: boolean;
}

/** The cost card of a version (GET boms/:id/cost, ADR-032 §4). Amounts are strings. */
export class BomCostCardDto {
  @ApiProperty({ type: 'string' })
  bomId!: string;

  @ApiProperty({ type: 'integer' })
  versionNo!: number;

  @ApiProperty({ type: 'string' })
  status!: string;

  @ApiProperty({ type: 'boolean' })
  isRecipe!: boolean;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outputQtyBase!: string;

  /** A recipe in the tree has no ACTIVE version (only meaningful for a recipe): the lines are partial. */
  @ApiProperty({ type: 'boolean' })
  missingBom!: boolean;

  @ApiProperty({ type: 'boolean' })
  zeroCostWarning!: boolean;

  @ApiProperty({ type: () => BomCostLineDto, isArray: true })
  lines!: BomCostLineDto[];

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalCost!: string;

  /** The cost per output unit (6 dp). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  unitCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  salePrice!: string | null;

  @ApiProperty({ type: 'boolean', nullable: true })
  pricesIncludeTax!: boolean | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  salePriceNet!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  margin!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true })
  marginPct!: string | null;
}
