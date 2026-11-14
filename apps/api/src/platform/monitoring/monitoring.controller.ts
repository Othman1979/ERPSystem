import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DomainError } from '../../common/errors/domain.error.js';
import { PlatformAdmin, TenantOptional } from '../../common/decorators/auth.decorators.js';
import { ClientErrorDto, ListErrorsQueryDto } from './dto/monitoring.dto.js';
import { AdminErrorDetailDto, AdminErrorRowDto } from './dto/monitoring-response.dto.js';
import { MonitoringService } from './monitoring.service.js';

/**
 * An error id from the path: digits only, else not found (never a 500 from BigInt).
 */
function errorId(id: string): bigint {
  if (!/^\d{1,20}$/.test(id)) throw DomainError.notFound('ErrorEvent', id);
  return BigInt(id);
}

/**
 * Errors the web app reports (ADR-010 §10.3): any signed-in user, at most 60
 * reports an hour per user (the web app sends at most 5 per page load), so one
 * user cannot fill the error table.
 */
@ApiTags('monitoring')
@Controller('client-errors')
@TenantOptional()
export class ClientErrorsController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Post()
  @HttpCode(204)
  @ApiNoContentResponse()
  @Throttle({ default: { limit: 60, ttl: 3_600_000 } })
  async report(@Body() dto: ClientErrorDto): Promise<void> {
    await this.monitoring.reportClientError(dto);
  }
}

/** The platform console's error list (ADR-010 §10.3). */
@ApiTags('admin')
@Controller('admin/errors')
@PlatformAdmin()
@TenantOptional()
export class AdminErrorsController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get()
  @ApiOkResponse({ type: AdminErrorRowDto, isArray: true })
  list(@Query() q: ListErrorsQueryDto) {
    return this.monitoring.list(q);
  }

  @Get(':id')
  @ApiOkResponse({ type: AdminErrorDetailDto })
  get(@Param('id') id: string) {
    return this.monitoring.get(errorId(id));
  }

  @Post(':id/resolve')
  @ApiCreatedResponse({ type: AdminErrorDetailDto })
  resolve(@Param('id') id: string) {
    return this.monitoring.setResolved(errorId(id), true);
  }

  @Post(':id/reopen')
  @ApiCreatedResponse({ type: AdminErrorDetailDto })
  reopen(@Param('id') id: string) {
    return this.monitoring.setResolved(errorId(id), false);
  }
}
