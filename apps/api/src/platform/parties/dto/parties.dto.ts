import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'] as const;
const MONEY = /^\d+(\.\d{1,3})?$/;

export class CreatePartyDto {
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

  @IsIn(PARTY_TYPES)
  partyType!: (typeof PARTY_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  nationalId?: string;

  /** JoFotara buyer scheme for nationalId (0005 §5): NIN Jordanian, PN non-Jordanian. */
  @IsOptional()
  @IsIn(['NIN', 'PN'])
  nationalIdKind?: 'NIN' | 'PN';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @Matches(MONEY)
  creditLimit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  paymentTermsDays?: number;

  @IsOptional()
  @IsBoolean()
  isCashCustomer?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePartyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  nationalId?: string;

  /** JoFotara buyer scheme for nationalId (0005 §5): NIN Jordanian, PN non-Jordanian. */
  @IsOptional()
  @IsIn(['NIN', 'PN'])
  nationalIdKind?: 'NIN' | 'PN';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsOptional()
  @Matches(MONEY)
  creditLimit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  paymentTermsDays?: number;

  @IsOptional()
  @IsBoolean()
  isCashCustomer?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
