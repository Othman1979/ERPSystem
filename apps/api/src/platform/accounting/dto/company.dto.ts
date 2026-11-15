import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { ProcurementLevel, SalesOrderApproval, SalesReservation } from '../../../generated/prisma/enums.js';

/**
 * Company profile (setup wizard step 1 and settings, §13.4). A blank text
 * field clears the value; the tax number is digits (JoFotara, 0005 §2).
 */
export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  legalNameAr?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(191)
  legalNameEn?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @Matches(/^\d{1,50}$/, { message: 'taxNumber must be digits' })
  taxNumber?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  commercialRegistration?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(512)
  address?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  /** Prices typed on documents include the tax (§8.4). */
  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;

  /** Cost centres shown and enforced (ADR-024 §1.6). Off keeps posted lines and account flags as they are. */
  @IsOptional()
  @IsBoolean()
  costCentersEnabled?: boolean;

  /**
   * Purchasing cycle level (ADR-024 §2), needs company.manage. Raised any time;
   * lowered only with no open cycle documents (PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS).
   */
  @ApiPropertyOptional({ enum: ProcurementLevel, enumName: 'ProcurementLevel' })
  @IsOptional()
  @IsEnum(ProcurementLevel)
  procurementLevel?: ProcurementLevel;

  // Sales cycle settings (ADR-027 §1): owner only (SALES_SETTINGS_OWNER_ONLY in the service).

  /** A sales invoice must come from a confirmed sales order (ADR-027 §1). */
  @IsOptional()
  @IsBoolean()
  salesOrderRequired?: boolean;

  @ApiPropertyOptional({ enum: SalesReservation, enumName: 'SalesReservation' })
  @IsOptional()
  @IsEnum(SalesReservation)
  salesReservation?: SalesReservation;

  @ApiPropertyOptional({ enum: SalesOrderApproval, enumName: 'SalesOrderApproval' })
  @IsOptional()
  @IsEnum(SalesOrderApproval)
  salesOrderApproval?: SalesOrderApproval;

  /** The invoice price may not go below the order without a price approval (ADR-027 §4). */
  @IsOptional()
  @IsBoolean()
  salesPriceLocked?: boolean;

  /** Default validity of a new quote in days; 0 = no default expiry (ADR-027 §1). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  quoteValidityDays?: number;
}
