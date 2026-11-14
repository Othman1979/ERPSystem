import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { TenantOptional } from '../../common/decorators/auth.decorators.js';
import { AcceptInvitationDto } from './dto/users.dto.js';
import { MyInvitationAcceptedDto, MyInvitationDto } from './dto/users-response.dto.js';
import { InvitationsService } from './invitations.service.js';

/** The signed-in user's own invitations; no tenant context is needed to answer them. */
@ApiTags('me')
@Controller('me/invitations')
@TenantOptional()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @ApiOkResponse({ type: MyInvitationDto, isArray: true })
  list() {
    return this.invitations.list();
  }

  /** Needs the acceptance code; 10 tries a minute per user on top of the per-code limit. */
  @Post(':membershipId/accept')
  @HttpCode(200)
  @ApiOkResponse({ type: MyInvitationAcceptedDto })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept(@Param('membershipId') id: string, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(BigInt(id), dto.code);
  }

  @Post(':membershipId/decline')
  @HttpCode(204)
  @ApiNoContentResponse()
  async decline(@Param('membershipId') id: string): Promise<void> {
    await this.invitations.decline(BigInt(id));
  }
}
