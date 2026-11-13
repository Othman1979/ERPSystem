import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../common/config/env.validation.js';
import { StorageService } from '../common/storage/storage.service.js';
import { ErrorEventsService } from '../platform/monitoring/error-events.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BackupVerifyService } from './backup/backup-verify.service.js';
import { BackupService } from './backup/backup.service.js';
import { ErrorDigestService } from './error-digest.service.js';
import { PasswordService } from '../platform/auth/password.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PlatformAdminGrantService } from './platform-admin-grant.service.js';
import { PreflightService } from './preflight.service.js';
import { TenantPurgeService } from './tenant-purge.service.js';
import { TenantStatusService } from './tenant-status.service.js';

/**
 * Scheduled and manual jobs, run as one-shot commands (CLAUDE.md: no
 * daemons). Only config, the database and file storage: no HTTP, no e-invoice
 * worker (that job has its own module, EInvoiceJobsModule).
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule],
  providers: [
    TenantStatusService,
    TenantPurgeService,
    StorageService,
    PreflightService,
    PlatformAdminGrantService,
    PasswordResetService,
    PasswordService,
    BackupService,
    BackupVerifyService,
    ErrorDigestService,
    ErrorEventsService,
  ],
})
export class JobsModule {}
