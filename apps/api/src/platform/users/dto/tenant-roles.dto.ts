import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CUSTOM_ROLE_PERMISSIONS, type PermissionCode } from '../../../common/permissions/permissions.js';

/** Create or replace a company's own role (ADR-038). */
export class SaveTenantRoleDto {
  @ApiProperty({ example: 'SALES_CLERK' })
  @IsString()
  @Matches(/^[A-Z0-9_-]{2,50}$/)
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
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: CUSTOM_ROLE_PERMISSIONS, enumName: 'CustomRolePermission', isArray: true })
  @IsArray()
  @ArrayMaxSize(CUSTOM_ROLE_PERMISSIONS.length)
  @IsIn(CUSTOM_ROLE_PERMISSIONS, { each: true })
  permissions!: PermissionCode[];
}

export class TenantRoleDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() nameAr!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) nameEn!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: CUSTOM_ROLE_PERMISSIONS, enumName: 'CustomRolePermission', isArray: true })
  permissions!: PermissionCode[];
  /** Members (any status) holding this role. */
  @ApiProperty() memberCount!: number;
}

export class PermissionCatalogDto {
  @ApiProperty({ enum: CUSTOM_ROLE_PERMISSIONS, enumName: 'CustomRolePermission', isArray: true })
  assignable!: PermissionCode[];
}
