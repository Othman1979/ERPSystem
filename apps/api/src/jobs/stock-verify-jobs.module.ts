import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { CommonModule } from '../common/common.module.js';
import { validateEnv } from '../common/config/env.validation.js';
import { InventoryModule } from '../platform/inventory/inventory.module.js';
import { ErrorEventsService } from '../platform/monitoring/error-events.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StockVerifyService } from './stock-verify.service.js';

/**
 * What the `stock-verify` command needs: the inventory module (stock ledger)
 * with CLS for each tenant's context. No HTTP server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ClsModule.forRoot({ global: true }),
    CommonModule,
    PrismaModule,
    InventoryModule,
  ],
  providers: [StockVerifyService, ErrorEventsService],
})
export class StockVerifyJobsModule {}
