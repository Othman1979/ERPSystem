import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { CreateIssueRequestDto, ListIssueRequestsQueryDto } from './dto/issue-requests.dto.js';
import { IssueRequestDetailDto, IssueRequestListItemDto } from './dto/issue-requests-response.dto.js';
import { ReasonDto } from './dto/procurement.dto.js';
import { IssueRequestsService } from './issue-requests.service.js';

/**
 * Issue requests (ADR-026 §9, FULL level): a department asks the store for
 * items. Created, edited and submitted with purchase_request.manage (the
 * same requesters as purchase requests), approved or rejected with
 * purchase.approve, cancelled or closed with purchase.manage. Reads need
 * tenant.read at any level; every write checks the level on the server.
 * Every state change takes an Idempotency-Key (§10). The issue itself is
 * POST /issue-requests/:id/issue (goods notes).
 */
@ApiTags('issue-requests')
@Controller('issue-requests')
export class IssueRequestsController {
  constructor(private readonly requests: IssueRequestsService) {}

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(IssueRequestListItemDto)
  list(@Query() q: ListIssueRequestsQueryDto) {
    return this.requests.list(q);
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: IssueRequestDetailDto })
  get(@Param('id', ParseIdPipe) id: string) {
    return this.requests.get(BigInt(id));
  }

  @Post()
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiCreatedResponse({ type: IssueRequestDetailDto })
  create(@Body() dto: CreateIssueRequestDto) {
    return this.requests.create(dto);
  }

  @Put(':id')
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiOkResponse({ type: IssueRequestDetailDto })
  update(@Param('id', ParseIdPipe) id: string, @Body() dto: CreateIssueRequestDto) {
    return this.requests.update(BigInt(id), dto);
  }

  @Delete(':id')
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  delete(@Param('id', ParseIdPipe) id: string) {
    return this.requests.deleteDraft(BigInt(id));
  }

  @Post(':id/submit')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiCreatedResponse({ type: IssueRequestDetailDto })
  submit(@Param('id', ParseIdPipe) id: string) {
    return this.requests.submit(BigInt(id));
  }

  @Post(':id/approve')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiCreatedResponse({ type: IssueRequestDetailDto })
  approve(@Param('id', ParseIdPipe) id: string) {
    return this.requests.approve(BigInt(id));
  }

  @Post(':id/reject')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiCreatedResponse({ type: IssueRequestDetailDto })
  reject(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.requests.reject(BigInt(id), dto.reason);
  }

  @Post(':id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: IssueRequestDetailDto })
  cancel(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.requests.cancel(BigInt(id), dto.reason);
  }

  @Post(':id/close')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: IssueRequestDetailDto })
  close(@Param('id', ParseIdPipe) id: string) {
    return this.requests.close(BigInt(id));
  }
}
