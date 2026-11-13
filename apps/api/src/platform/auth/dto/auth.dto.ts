import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  @MaxLength(191)
  tenantName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(191)
  ownerName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  companyNameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'tenantId must be a numeric id' })
  tenantId?: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}

export class SwitchTenantDto {
  @IsString()
  @Matches(/^\d{1,19}$/, { message: 'tenantId must be a numeric id' })
  tenantId!: string;
}
