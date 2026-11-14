/**
 * Response shapes of the team (users) and invitation routes (PLAT-15). They
 * describe what UsersService and InvitationsService return today; nothing here
 * changes a body.
 */
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { RolePermissionRow, RoleRow } from '../../../common/openapi/prisma-models.js';
import { MembershipStatus } from '../../../generated/prisma/enums.js';

/** A permission granted to a system role. */
export class UserRolePermissionDto extends PickType(RolePermissionRow, ['permissionCode'] as const) {}

/** A system role with its permission codes (UsersService.roles). */
export class UserRoleDto extends RoleRow {
  @ApiProperty({ type: () => UserRolePermissionDto, isArray: true })
  permissions!: UserRolePermissionDto[];
}

/** The member's account as a team view shows it; `fullName` is hidden until the invitee accepts. */
export class UserMembershipUserDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  email!: string;

  @ApiProperty({ type: 'string', nullable: true, description: 'Null while the membership is INVITED.' })
  fullName!: string | null;

  @ApiProperty({ type: 'boolean' })
  isActive!: boolean;
}

/** The role of a membership in a team view. */
export class UserMembershipRoleDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** A branch a member can work in: id, code and Arabic name only. */
export class UserMembershipBranchDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;
}

/** A membership as the team screens show it (UsersService `serialize`). */
export class UserMembershipDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ enum: MembershipStatus, enumName: 'MembershipStatus' })
  status!: MembershipStatus;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: () => UserMembershipUserDto })
  user!: UserMembershipUserDto;

  @ApiProperty({ type: () => UserMembershipRoleDto })
  role!: UserMembershipRoleDto;

  @ApiProperty({ type: () => UserMembershipBranchDto, nullable: true })
  defaultBranch!: UserMembershipBranchDto | null;

  @ApiProperty({ type: () => UserMembershipBranchDto, isArray: true })
  branches!: UserMembershipBranchDto[];
}

/**
 * Body of POST /users/invite (UsersService.invite): the membership, plus
 * `temporaryPassword` for a new account, or the acceptance code for an existing one.
 */
export class UserInviteResultDto extends UserMembershipDto {
  @ApiPropertyOptional({ type: 'string', description: 'Only for a brand-new account.' })
  temporaryPassword?: string;

  @ApiPropertyOptional({ type: 'string', description: 'Only for an existing account (status INVITED).' })
  acceptanceCode?: string;

  @ApiPropertyOptional({ type: 'string', format: 'date-time' })
  acceptanceCodeExpiresAt?: string;
}

/** A new acceptance code for a pending invitation (UsersService.reissueInvitationCode). */
export class UserInvitationCodeDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ type: 'string' })
  acceptanceCode!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  acceptanceCodeExpiresAt!: string;
}

/** A temporary password set by an admin (UsersService.resetPassword). */
export class UserTemporaryPasswordDto {
  @ApiProperty({ type: 'string' })
  temporaryPassword!: string;
}

/** The result of cancelling a pending invitation (UsersService.cancelInvitation). */
export class UserInvitationCancelledDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ type: 'boolean', enum: [true] })
  cancelled!: true;
}

/** An invitation the signed-in user has not answered yet (InvitationsService.list). */
export class MyInvitationRoleDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** Who sent the invitation; null when the inviter is unknown or gone. */
export class MyInvitationInviterDto {
  @ApiProperty({ type: 'string' })
  fullName!: string;

  @ApiProperty({ type: 'string' })
  email!: string;
}

/** One of the signed-in user's pending invitations (InvitationsService.list). */
export class MyInvitationDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ type: 'string' })
  tenantId!: string;

  @ApiProperty({ type: 'string' })
  tenantName!: string;

  @ApiProperty({ type: () => MyInvitationRoleDto })
  role!: MyInvitationRoleDto;

  @ApiProperty({ type: () => MyInvitationInviterDto, nullable: true })
  invitedBy!: MyInvitationInviterDto | null;

  @ApiProperty({ type: 'string', format: 'date-time' })
  invitedAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Null when no code is pending.' })
  codeExpiresAt!: string | null;
}

/** The company the user joined by accepting an invitation (InvitationsService.accept). */
export class MyInvitationAcceptedDto {
  @ApiProperty({ type: 'string' })
  membershipId!: string;

  @ApiProperty({ type: 'string' })
  tenantId!: string;

  @ApiProperty({ type: 'string' })
  tenantName!: string;
}
