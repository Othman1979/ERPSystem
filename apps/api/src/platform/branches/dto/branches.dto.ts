import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string;
}

export class UpdateBranchDto {
  /** Not nullable: a null is validated (and refused), only an absent field is skipped. */
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr?: string;

  /** null clears the English name. */
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 191 })
  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  /** null clears the address. */
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string | null;

  // null is refused (400), not passed to Prisma.
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}
