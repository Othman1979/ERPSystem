import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TenantOptional } from '../../common/decorators/auth.decorators.js';
import { InvitationsService } from './invitations.service.js';

/** The signed-in user's own invitations; no tenant context is needed to answer them. */
@ApiTags('me')
@Controller('me/invitations')
@TenantOptional()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  list() {
    return this.invitations.list();
  }

  @Post(':membershipId/accept')
  @HttpCode(200)
  accept(@Param('membershipId') id: string) {
    return this.invitations.accept(BigInt(id));
  }

  @Post(':membershipId/decline')
  @HttpCode(204)
  async decline(@Param('membershipId') id: string): Promise<void> {
    await this.invitations.decline(BigInt(id));
  }
}
