import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module.js';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';
import { PartyUsageRegistry } from './party-usage.registry.js';

@Module({
  imports: [SharedModule],
  controllers: [PartiesController],
  providers: [PartiesService, PartyUsageRegistry],
  // Treasury aging names parties that only have journal balances.
  // PartyUsageRegistry: the modules that reference parties register their
  // "party in use" checks with it (DB-15, ADR-021).
  exports: [PartiesService, PartyUsageRegistry],
})
export class PartiesModule {}
