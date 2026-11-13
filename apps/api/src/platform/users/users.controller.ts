import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { InviteUserDto, UpdateMembershipDto } from './dto/users.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('roles')
  roles() {
    return this.users.roles();
  }

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  list() {
    return this.users.list();
  }

  @Post('invite')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  invite(@Body() dto: InviteUserDto) {
    return this.users.invite(dto);
  }

  @Patch(':membershipId')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  update(@Param('membershipId') id: string, @Body() dto: UpdateMembershipDto) {
    return this.users.update(BigInt(id), dto);
  }

  /** Replaces the member's password with a temporary one (ADR-012). */
  @Post(':membershipId/reset-password')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  resetPassword(@Param('membershipId') id: string) {
    return this.users.resetPassword(BigInt(id));
  }

  @Delete(':membershipId')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  suspend(@Param('membershipId') id: string) {
    return this.users.suspend(BigInt(id));
  }
}
