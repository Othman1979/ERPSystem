import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { GoodsNotesService } from './goods-notes.service.js';
import { IssueFromRequestDto, ReceivePurchaseOrderDto } from './dto/goods-notes.dto.js';
import { GoodsNoteDetailDto } from './dto/goods-notes-response.dto.js';

/**
 * ADR-026 §5 and §9: the goods-note actions that start from a procurement
 * document. Each creates a DRAFT note (posted through POST /goods-notes/:id/post)
 * and takes an Idempotency-Key (§10).
 */
@ApiTags('goods-notes')
@Controller()
export class ReceivingController {
  constructor(private readonly notes: GoodsNotesService) {}

  /** A draft GRN against the approved order, for the given lines or what is left on each. */
  @Post('purchase-orders/:id/receive')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: GoodsNoteDetailDto })
  receive(@Param('id', ParseIdPipe) id: string, @Body() dto: ReceivePurchaseOrderDto) {
    return this.notes.receive(BigInt(id), dto);
  }

  /** A draft GIN from the approved issue request (FULL level), for the given lines or what is left on each. */
  @Post('issue-requests/:id/issue')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: GoodsNoteDetailDto })
  issue(@Param('id', ParseIdPipe) id: string, @Body() dto: IssueFromRequestDto) {
    return this.notes.issueFromRequest(BigInt(id), dto);
  }
}
