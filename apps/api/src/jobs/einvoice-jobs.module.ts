import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { CommonModule } from '../common/common.module.js';
import { validateEnv } from '../common/config/env.validation.js';
import { EInvoiceModule } from '../platform/einvoice/einvoice.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';

/**
 * What the `einvoice-send` command needs: the e-invoice module (sender,
 * worker) with CLS for the tenant context of each send. No HTTP server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ClsModule.forRoot({ global: true }),
    CommonModule,
    PrismaModule,
    EInvoiceModule,
  ],
})
export class EInvoiceJobsModule {}
