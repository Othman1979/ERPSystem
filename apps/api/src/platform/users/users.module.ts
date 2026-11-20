import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { TenantRolesController } from './tenant-roles.controller.js';
import { TenantRolesService } from './tenant-roles.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, InvitationsController, TenantRolesController],
  providers: [UsersService, InvitationsService, TenantRolesService],
})
export class UsersModule {}
