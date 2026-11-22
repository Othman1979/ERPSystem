import { Module } from '@nestjs/common';
import { AdminPlansController } from './admin-plans.controller.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';

@Module({
  controllers: [AdminController, AdminPlansController],
  imports: [TenancyModule],
  providers: [AdminService],
})
export class AdminModule {}
