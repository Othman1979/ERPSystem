import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { GoodsNotesService } from './goods-notes.service.js';
import { CreateGoodsNoteDto } from './dto/goods-notes.dto.js';
import { GoodsNoteDetailDto, GoodsNoteListItemDto } from './dto/goods-notes-response.dto.js';
import { ListGoodsNotesQueryDto } from '../inventory/dto/list-queries.dto.js';

@ApiTags('goods-notes')
@Controller('goods-notes')
export class GoodsNotesController {
  constructor(private readonly notes: GoodsNotesService) {}

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(GoodsNoteListItemDto)
  list(@Query() q: ListGoodsNotesQueryDto) {
    return this.notes.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: GoodsNoteDetailDto })
  get(@Param('id') id: string) {
    return this.notes.get(BigInt(id));
  }

  @Post()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: GoodsNoteDetailDto })
  create(@Body() dto: CreateGoodsNoteDto) {
    return this.notes.create(dto);
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: GoodsNoteDetailDto })
  update(@Param('id') id: string, @Body() dto: CreateGoodsNoteDto) {
    return this.notes.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: DeletedDto })
  delete(@Param('id') id: string) {
    return this.notes.deleteDraft(BigInt(id));
  }

  @Post(':id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: GoodsNoteDetailDto })
  post(@Param('id') id: string) {
    return this.notes.post(BigInt(id));
  }
}
