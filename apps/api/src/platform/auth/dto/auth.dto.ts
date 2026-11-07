import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
  tenantId?: string;
}

export class SwitchTenantDto {
  @IsString()
  tenantId!: string;
}
