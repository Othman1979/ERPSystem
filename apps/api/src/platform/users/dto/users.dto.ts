import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MEMBER_PERMISSION_CODES, type MemberPermissionCode } from '../../../common/permissions/member-permissions.js';
import { AMOUNT_PATTERN } from '../../../common/pipes/parse-id.pipe.js';

/** Branch and default-branch ids are unsigned BIGINTs, sent as decimal strings (CLAUDE.md). */
const ID_PATTERN = /^\d{1,19}$/;

export class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  fullName?: string;

  @IsString()
  @MaxLength(50)
  roleCode!: string;

  // The inviter never chooses a password. An existing user accepts the invitation
  // with their own password; a new user receives a temporary one in the response.

  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  defaultBranchId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(ID_PATTERN, { each: true })
  branchIds?: string[];
}

/** One purchase permission of a member (ADR-024 §3.1). */
export class MemberPermissionGrantDto {
  @ApiProperty({ enum: MEMBER_PERMISSION_CODES, enumName: 'MemberPermissionCode' })
  @IsIn(MEMBER_PERMISSION_CODES)
  code!: MemberPermissionCode;

  /**
   * purchase.approve only: the highest amount the member approves alone, a
   * decimal string above zero with up to 3 decimals. Absent or null: no
   * limit (GET users answers null for no limit, so it may be sent back as is).
   */
  @ApiPropertyOptional({ type: 'string', format: 'decimal', nullable: true, example: '1500.000' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: 'amountLimit must be a decimal string with up to 3 decimals' })
  amountLimit?: string | null;
}

/**
 * The member's whole set of purchase permissions: what is listed is granted,
 * what is left out is revoked (PUT users/:membershipId/purchase-permissions).
 */
export class UpdatePurchasePermissionsDto {
  @ApiProperty({ type: () => MemberPermissionGrantDto, isArray: true })
  @IsArray()
  @ArrayMaxSize(MEMBER_PERMISSION_CODES.length)
  @ArrayUnique((g: MemberPermissionGrantDto) => g.code)
  @ValidateNested({ each: true })
  @Type(() => MemberPermissionGrantDto)
  permissions!: MemberPermissionGrantDto[];
}

/** The acceptance code the inviting admin handed over (ADR-012 §PLAT-10). */
export class AcceptInvitationDto {
  // Optional here so that someone else's invitation answers 404 before the
  // code is asked for (isolation); the service refuses a missing code.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string;
}

export class UpdateMembershipDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  roleCode?: string;

  /** A tenant role (ADR-038) replacing the system role's permissions; null clears it. */
  @ValidateIf((o: UpdateMembershipDto) => o.customRoleId !== null)
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  customRoleId?: string | null;

  /** INVITED is never set by an admin: only the invitee accepts (or the inviter cancels). */
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';

  /** null clears the default branch; a string must be a branch id. */
  @ValidateIf((o: UpdateMembershipDto) => o.defaultBranchId !== null)
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  defaultBranchId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(ID_PATTERN, { each: true })
  branchIds?: string[];
}
