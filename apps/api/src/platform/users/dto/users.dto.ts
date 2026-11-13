import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

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

/** The acceptance code the inviting admin handed over (ADR-012 §PLAT-10). */
export class AcceptInvitationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;
}

export class UpdateMembershipDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  roleCode?: string;

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
