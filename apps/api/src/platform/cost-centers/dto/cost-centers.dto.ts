import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';

/** POST /cost-centers: a root centre, or a child of `parentId` (which becomes a group). */
export class CreateCostCenterDto {
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
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  parentId?: string;
}

/** PATCH /cost-centers/:id: names, and `isActive` to deactivate or reactivate. Code and parent are fixed. */
export class UpdateCostCenterDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
