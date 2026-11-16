import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { ApiFileResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import { bomPrint } from './bom.print.js';
import { BomService } from './bom.service.js';
import { BomRequirementsQueryDto, CreateBomDto, ListBomsQueryDto, UpdateBomDto } from './dto/bom.dto.js';
import { BomDetailDto, BomListItemDto, BomRequirementsDto } from './dto/bom-response.dto.js';

/** Bill of materials versions (ADR-031 §5). Writes need the item permission; reads need tenant access. */
@ApiTags('manufacturing')
@Controller('boms')
export class BomsController {
  constructor(
    private readonly boms: BomService,
    private readonly printing: PrintingService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(BomListItemDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022). */
  list(@Query() q: ListBomsQueryDto) {
    return this.boms.list(q);
  }

  @Post()
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: BomDetailDto })
  create(@Body() dto: CreateBomDto) {
    return this.boms.create(dto);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: BomDetailDto })
  get(@Param('id', ParseIdPipe) id: string) {
    return this.boms.get(BigInt(id));
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ type: BomDetailDto })
  update(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateBomDto) {
    return this.boms.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteDraft(@Param('id', ParseIdPipe) id: string) {
    return this.boms.deleteDraft(BigInt(id));
  }

  @Post(':id/copy')
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: BomDetailDto })
  copy(@Param('id', ParseIdPipe) id: string) {
    return this.boms.copy(BigInt(id));
  }

  @Post(':id/activate')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: BomDetailDto })
  activate(@Param('id', ParseIdPipe) id: string) {
    return this.boms.activate(BigInt(id));
  }

  @Post(':id/deactivate')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.ITEM_MANAGE)
  @ApiCreatedResponse({ type: BomDetailDto })
  deactivate(@Param('id', ParseIdPipe) id: string) {
    return this.boms.deactivate(BigInt(id));
  }

  /** Standard requirements for a quantity of the output, one level (ADR-031 §6). */
  @Get(':id/requirements')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: BomRequirementsDto })
  requirements(@Param('id', ParseIdPipe) id: string, @Query() q: BomRequirementsQueryDto) {
    return this.boms.requirements(BigInt(id), q.qty);
  }

  @Get(':id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async pdf(@Param('id', ParseIdPipe) id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(bomPrint(await this.boms.get(BigInt(id)), lang), lang);
  }
}
