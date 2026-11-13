import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, InvitationsController],
  providers: [UsersService, InvitationsService],
})
export class UsersModule {}
