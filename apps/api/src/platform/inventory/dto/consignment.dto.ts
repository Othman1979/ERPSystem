import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';

const ID = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ConsignmentOpenSalesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ID)
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ID)
  warehouseId?: string;
}

export class ConsignmentStatementQueryDto {
  @IsString()
  @Matches(ID)
  supplierId!: string;

  @IsDateString({ strict: true })
  @Matches(DATE)
  from!: string;

  @IsDateString({ strict: true })
  @Matches(DATE)
  to!: string;
}

export class ConsignmentAgingQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(ID)
  supplierId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(DATE)
  asOf?: string;
}
