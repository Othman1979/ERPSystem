import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PartiesService } from './parties.service.js';
import { CreatePartyDto, UpdatePartyDto } from './dto/parties.dto.js';

@ApiTags('parties')
@Controller('parties')
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  list(@Query('partyType') partyType?: string, @Query('isActive') isActive?: string) {
    return this.parties.list(partyType, isActive);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  get(@Param('id') id: string) {
    return this.parties.get(BigInt(id));
  }

  @Post()
  @RequirePermission(PERMISSIONS.PARTIES_MANAGE)
  create(@Body() dto: CreatePartyDto) {
    return this.parties.create(dto);
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.PARTIES_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdatePartyDto) {
    return this.parties.update(BigInt(id), dto);
  }

  @Patch(':id/deactivate')
  @RequirePermission(PERMISSIONS.PARTIES_MANAGE)
  deactivate(@Param('id') id: string) {
    return this.parties.deactivate(BigInt(id));
  }
}
