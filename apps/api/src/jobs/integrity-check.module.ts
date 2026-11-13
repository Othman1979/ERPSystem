import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../common/config/env.validation.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { IntegrityCheckService } from './integrity-check.service.js';

/**
 * One-shot integrity check (`job:integrity-check`): config and the database
 * only, no HTTP and no workers (CLAUDE.md: no daemons).
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule],
  providers: [IntegrityCheckService],
})
export class IntegrityCheckModule {}
