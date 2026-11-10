import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module.js';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';

@Module({
  imports: [SharedModule],
  controllers: [PartiesController],
  providers: [PartiesService],
  // Treasury aging names parties that only have journal balances.
  exports: [PartiesService],
})
export class PartiesModule {}
