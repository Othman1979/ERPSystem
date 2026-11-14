import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiOneOfResponse, ApiPagedResponse, DeactivatedDto, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PartiesService } from './parties.service.js';
import { CreatePartyDto, ListPartiesQueryDto, UpdatePartyDto } from './dto/parties.dto.js';
import { PartyDto } from './dto/parties-response.dto.js';

@ApiTags('parties')
@Controller('parties')
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(PartyDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022). */
  list(@Query() q: ListPartiesQueryDto) {
    return this.parties.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: PartyDto })
  get(@Param('id') id: string) {
    return this.parties.get(BigInt(id));
  }

  @Post()
  @RequirePermission(PERMISSIONS.PARTIES_MANAGE)
  @ApiCreatedResponse({ type: PartyDto })
  create(@Body() dto: CreatePartyDto) {
    return this.parties.create(dto);
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.PARTIES_MANAGE)
  @ApiOkResponse({ type: PartyDto })
  update(@Param('id') id: string, @Body() dto: UpdatePartyDto) {
    return this.parties.update(BigInt(id), dto);
  }

  @Patch(':id/deactivate')
  @RequirePermission(PERMISSIONS.PARTIES_MANAGE)
  /** Deactivated when the party is in use, deleted otherwise. */
  @ApiOneOfResponse(200, [DeactivatedDto, DeletedDto])
  deactivate(@Param('id') id: string) {
    return this.parties.deactivate(BigInt(id));
  }
}
