/**
 * Response shapes of the recipe routes (ADR-032 §12): the draft's recipe preview.
 * Ids, quantities and amounts are strings (CLAUDE.md).
 */
import { ApiProperty } from '@nestjs/swagger';

export class RecipePreviewComponentDto {
  @ApiProperty({ type: 'string' })
  componentItemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  /** Quantity the sale takes, in the base unit (6 dp). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  /** On hand in the invoice warehouse before the sale (6 dp). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  onHandBase!: string;

  /** The part of the quantity the warehouse does not hold (0 when enough). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  shortageBase!: string;
}

export class RecipePreviewLineDto {
  @ApiProperty({ type: 'string' })
  lineId!: string;

  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  itemCode!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  /** True when the recipe has no ACTIVE bill of materials: the line posts at cost 0 (ADR-032 §1). */
  @ApiProperty({ type: 'boolean' })
  bomMissing!: boolean;

  @ApiProperty({ type: () => RecipePreviewComponentDto, isArray: true })
  components!: RecipePreviewComponentDto[];
}

export class RecipePreviewDto {
  @ApiProperty({ type: 'string' })
  invoiceId!: string;

  @ApiProperty({ type: 'string' })
  warehouseId!: string;

  @ApiProperty({ type: 'boolean' })
  hasWarnings!: boolean;

  @ApiProperty({ type: 'boolean' })
  hasShortage!: boolean;

  @ApiProperty({ type: () => RecipePreviewLineDto, isArray: true })
  lines!: RecipePreviewLineDto[];
}
