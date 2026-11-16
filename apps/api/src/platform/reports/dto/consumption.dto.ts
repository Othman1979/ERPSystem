/**
 * Query and response shapes of the consumption report between two counts and of the recipe sales
 * without a bill of materials (ADR-032 §6). Ids, quantities and amounts are strings (CLAUDE.md).
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsString, Matches } from 'class-validator';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

const INT_STRING = /^\d+$/;

export class ConsumptionQueryDto extends ExportQueryDto {
  @ApiProperty({ type: 'string' })
  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

  /** The earlier POSTED count of the warehouse. */
  @ApiProperty({ type: 'string' })
  @IsString()
  @Matches(INT_STRING)
  fromCountId!: string;

  /** The later POSTED count of the warehouse. */
  @ApiProperty({ type: 'string' })
  @IsString()
  @Matches(INT_STRING)
  toCountId!: string;
}

export class RecipeSalesWithoutBomQueryDto {
  @ApiProperty({ type: 'string', format: 'date' })
  @IsDateString()
  from!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  @IsDateString()
  to!: string;
}

export class ConsumptionRowDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  avgCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingCounted!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  receipts!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingCounted!: string;

  /** opening + receipts − closing. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  actual!: string;

  /** Every OUT movement of the window (recipes, direct sales and others). */
  @ApiProperty({ type: 'string', format: 'decimal' })
  recorded!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  recipeOut!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  directSales!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  otherOut!: string;

  /** actual − recorded: the waste or the loss that was not recorded. */
  @ApiProperty({ type: 'string', format: 'decimal' })
  variance!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  actualValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  recordedValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  varianceValue!: string;
}

export class ConsumptionCountRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  countDate!: string;
}

export class ConsumptionTotalsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  actualValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  recordedValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  varianceValue!: string;
}

export class ConsumptionReportDto {
  @ApiProperty({ type: 'string' })
  warehouseId!: string;

  @ApiProperty({ type: () => ConsumptionCountRefDto })
  fromCount!: ConsumptionCountRefDto;

  @ApiProperty({ type: () => ConsumptionCountRefDto })
  toCount!: ConsumptionCountRefDto;

  @ApiProperty({ type: () => ConsumptionRowDto, isArray: true })
  rows!: ConsumptionRowDto[];

  @ApiProperty({ type: () => ConsumptionTotalsDto })
  totals!: ConsumptionTotalsDto;
}

export class RecipeSalesWithoutBomRowDto {
  @ApiProperty({ type: 'string' })
  invoiceId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  invoiceNo!: string | null;

  @ApiProperty({ type: 'string', format: 'date' })
  invoiceDate!: string;

  @ApiProperty({ type: 'string' })
  lineId!: string;

  @ApiProperty({ type: 'integer' })
  lineNo!: number;

  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  itemCode!: string;

  @ApiProperty({ type: 'string' })
  itemNameAr!: string;

  @ApiPropertyOptional({ type: 'string', nullable: true })
  itemNameEn!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  netAmount!: string;
}
