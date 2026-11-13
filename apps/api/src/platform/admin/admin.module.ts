import { Module } from '@nestjs/common';
import { AdminPlansController } from './admin-plans.controller.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  controllers: [AdminController, AdminPlansController],
  providers: [AdminService],
})
export class AdminModule {}
