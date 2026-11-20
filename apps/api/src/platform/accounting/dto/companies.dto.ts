import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  legalNameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  legalNameEn?: string;
}

export class UpdateCompanyEntryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  legalNameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  legalNameEn?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CompanyEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() legalNameAr!: string;
  @ApiProperty({ type: String, nullable: true }) legalNameEn!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() current!: boolean;
}
