import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PlatformAdmin, TenantOptional } from '../../common/decorators/auth.decorators.js';
import { ClientErrorDto, ListErrorsQueryDto } from './dto/monitoring.dto.js';
import { MonitoringService } from './monitoring.service.js';

/** Errors the web app reports (ADR-010 §10.3): any signed-in user, limited per user. */
@ApiTags('monitoring')
@Controller('client-errors')
@TenantOptional()
export class ClientErrorsController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
  list(@Query() q: ListErrorsQueryDto) {
    return this.monitoring.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.monitoring.get(BigInt(id));
  }

  @Post(':id/resolve')
  resolve(@Param('id', ParseIntPipe) id: number) {
    return this.monitoring.setResolved(BigInt(id), true);
  }

  @Post(':id/reopen')
  reopen(@Param('id', ParseIntPipe) id: number) {
    return this.monitoring.setResolved(BigInt(id), false);
  }
}
