import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ListEInvoiceSubmissionsQueryDto, UpdateEInvoiceSettingsDto } from './dto/einvoice.dto.js';
import { EInvoiceSettingsService } from './einvoice-settings.service.js';
import { EInvoiceSubmissionsService } from './einvoice-submissions.service.js';
import {
  EInvoiceSettingsViewDto,
  EInvoiceSubmissionDetailDto,
  EInvoiceSubmissionPageDto,
} from './dto/einvoice-response.dto.js';

/** JoFotara settings and the follow-up screen (Phase 7, docs/decisions/0005). */
@ApiTags('einvoice')
@Controller('einvoice')
export class EInvoiceController {
  constructor(
    private readonly settings: EInvoiceSettingsService,
    private readonly submissions: EInvoiceSubmissionsService,
  ) {}

  @Get('settings')
  @RequirePermission(PERMISSIONS.EINVOICE_MANAGE)
  @ApiOkResponse({ type: EInvoiceSettingsViewDto })
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  @RequirePermission(PERMISSIONS.EINVOICE_MANAGE)
  @ApiOkResponse({ type: EInvoiceSettingsViewDto })
  updateSettings(@Body() dto: UpdateEInvoiceSettingsDto) {
    return this.settings.update(dto);
  }

  @Get('submissions')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: EInvoiceSubmissionPageDto })
  /** Numbered page `{ items, page, pageSize, total, counts }` (ADR-022), the caller's branches only. */
  listSubmissions(@Query() q: ListEInvoiceSubmissionsQueryDto) {
    return this.submissions.list(q);
  }

  @Get('submissions/:id')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: EInvoiceSubmissionDetailDto })
  getSubmission(@Param('id') id: string) {
    return this.submissions.get(BigInt(id));
  }

  @Post('submissions/:id/resend')
  @RequirePermission(PERMISSIONS.EINVOICE_MANAGE)
  @ApiCreatedResponse({ type: EInvoiceSubmissionDetailDto })
  resend(@Param('id') id: string) {
    return this.submissions.resend(BigInt(id));
  }
}
