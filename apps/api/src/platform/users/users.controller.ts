import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ApiOneOfResponse } from '../../common/openapi/responses.js';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { InviteUserDto, UpdateMembershipDto } from './dto/users.dto.js';
import {
  UserInvitationCancelledDto,
  UserInvitationCodeDto,
  UserInviteResultDto,
  UserMembershipDto,
  UserRoleDto,
  UserTemporaryPasswordDto,
} from './dto/users-response.dto.js';
import { UsersService } from './users.service.js';

/** Team management belongs to the owner only (user.manage), including the directory and roles (PLAT-28). */
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('roles')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: UserRoleDto, isArray: true })
  roles() {
    return this.users.roles();
  }

  @Get()
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: UserMembershipDto, isArray: true })
  list() {
    return this.users.list();
  }

  @Post('invite')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiCreatedResponse({ type: UserInviteResultDto })
  invite(@Body() dto: InviteUserDto) {
    return this.users.invite(dto);
  }

  @Patch(':membershipId')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: UserMembershipDto })
  update(@Param('membershipId') id: string, @Body() dto: UpdateMembershipDto) {
    return this.users.update(BigInt(id), dto);
  }

  /** A new acceptance code for a pending invitation; the old one stops working (ADR-012 §PLAT-10). */
  @Post(':membershipId/invitation-code')
  @ApiOkResponse({ type: UserInvitationCodeDto })
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  reissueInvitationCode(@Param('membershipId') id: string) {
    return this.users.reissueInvitationCode(BigInt(id));
  }

  /** Replaces the member's password with a temporary one (ADR-012). */
  @Post(':membershipId/reset-password')
  @ApiOkResponse({ type: UserTemporaryPasswordDto })
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  resetPassword(@Param('membershipId') id: string) {
    return this.users.resetPassword(BigInt(id));
  }

  /** Suspends a member, or cancels a pending invitation (INVITED). */
  @Delete(':membershipId')
  @ApiOneOfResponse(200, [UserInvitationCancelledDto, UserMembershipDto])
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  suspend(@Param('membershipId') id: string) {
    return this.users.suspend(BigInt(id));
  }
}
