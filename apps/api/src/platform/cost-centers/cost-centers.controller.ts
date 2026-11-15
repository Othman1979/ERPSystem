import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { CostCentersService } from './cost-centers.service.js';
import { CreateCostCenterDto, UpdateCostCenterDto } from './dto/cost-centers.dto.js';
import { CostCenterDto } from './dto/cost-centers-response.dto.js';

/** Cost centre tree (ADR-024 §1), organised like the chart of accounts. */
@ApiTags('cost-centers')
@Controller()
export class CostCentersController {
  constructor(private readonly centres: CostCentersService) {}

  /** Flat, by code (inactive ones too); the web builds the tree. */
  @Get('cost-centers')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: CostCenterDto, isArray: true })
  list() {
    return this.centres.list();
  }

  @Post('cost-centers')
  @RequirePermission(PERMISSIONS.COST_CENTER_MANAGE)
  @ApiCreatedResponse({ type: CostCenterDto })
  create(@Body() dto: CreateCostCenterDto) {
    return this.centres.create(dto);
  }

  /** Names, and `isActive: false` to deactivate a used centre. */
  @Patch('cost-centers/:id')
  @RequirePermission(PERMISSIONS.COST_CENTER_MANAGE)
  @ApiOkResponse({ type: CostCenterDto })
  update(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateCostCenterDto) {
    return this.centres.update(BigInt(id), dto);
  }

  /** An unused leaf only; a used centre answers COST_CENTER_IN_USE (deactivate it instead). */
  @Delete('cost-centers/:id')
  @RequirePermission(PERMISSIONS.COST_CENTER_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  remove(@Param('id', ParseIdPipe) id: string) {
    return this.centres.remove(BigInt(id));
  }
}
