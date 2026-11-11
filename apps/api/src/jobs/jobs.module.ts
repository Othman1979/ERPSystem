import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../common/config/env.validation.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TenantStatusService } from './tenant-status.service.js';

/**
 * Scheduled jobs, run as one-shot commands by Cron (CLAUDE.md: no daemons).
 * Only config and the database: no HTTP, no e-invoice worker.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule],
  providers: [TenantStatusService],
})
export class JobsModule {}
