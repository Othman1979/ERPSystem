import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

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
}
