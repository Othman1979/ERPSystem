import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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

import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'] as const;

/** An empty filter value (`?partyType=`) counts as "not given", as in the other lists. */
const blankToUndefined = ({ value }: { value: unknown }) => (value === '' ? undefined : value);
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
  /** Null clears it (no terms). */
  paymentTermsDays?: number | null;

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
  /** Null clears it. */
  nameEn?: string | null;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  /** Null clears it. */
  taxNumber?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  /** Null clears it. */
  nationalId?: string | null;

  /** JoFotara buyer scheme for nationalId (0005 §5): NIN Jordanian, PN non-Jordanian. */
  @IsOptional()
  @IsIn(['NIN', 'PN'])
  nationalIdKind?: 'NIN' | 'PN';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  /** Null clears it. */
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  /** Null clears it. */
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  /** Null clears it. */
  city?: string | null;

  @IsOptional()
  @Matches(MONEY)
  /** Null clears it (no limit). */
  creditLimit?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  /** Null clears it (no terms). */
  paymentTermsDays?: number | null;

  @IsOptional()
  @IsBoolean()
  isCashCustomer?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export const PARTY_SORT_KEYS = ['code', 'nameAr'] as const;
export const PARTY_SORTS = sortValues(PARTY_SORT_KEYS);

/**
 * GET /parties (ADR-022 §2): a numbered page of the company's parties, by code
 * unless `sort` says otherwise. Master data: not narrowed by branch.
 * `q` matches the code, the Arabic and English names, phone and tax number.
 */
export class ListPartiesQueryDto extends PageQueryDto {
  @SortParam(PARTY_SORTS, 'code')
  sort?: (typeof PARTY_SORTS)[number];

  /** Exact party type: BOTH is listed only by `partyType=BOTH`. */
  @ApiPropertyOptional({ enum: PARTY_TYPES })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number];

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';
}
