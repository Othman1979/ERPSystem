import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { CommonModule } from './common/common.module.js';
import { validateEnv } from './common/config/env.validation.js';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor.js';
import { SerializeInterceptor } from './common/interceptors/serialize.interceptor.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { PlatformAdminGuard } from './common/guards/platform-admin.guard.js';
import { TenantGuard } from './common/guards/tenant.guard.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './platform/auth/auth.module.js';
import { AdminModule } from './platform/admin/admin.module.js';
import { BranchesModule } from './platform/branches/branches.module.js';
import { UsersModule } from './platform/users/users.module.js';
import { AccountingModule } from './platform/accounting/accounting.module.js';
import { JournalModule } from './platform/journal/journal.module.js';
import { InventoryModule } from './platform/inventory/inventory.module.js';
import { PartiesModule } from './platform/parties/parties.module.js';
import { SalesModule } from './platform/sales/sales.module.js';
import { PurchasesModule } from './platform/purchases/purchases.module.js';
import { GoodsNotesModule } from './platform/goods-notes/goods-notes.module.js';
import { TreasuryModule } from './platform/treasury/treasury.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, saveReq: true, generateId: true },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    CommonModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    BranchesModule,
    AccountingModule,
    JournalModule,
    InventoryModule,
    PartiesModule,
    SalesModule,
    PurchasesModule,
    GoodsNotesModule,
    TreasuryModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Idempotency must run BEFORE SerializeInterceptor so stored responses
    // are already in wire format.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SerializeInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: PlatformAdminGuard },
  ],
})
export class AppModule {}
