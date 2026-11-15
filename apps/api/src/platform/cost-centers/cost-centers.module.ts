import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module.js';
import { CostCenterUsageRegistry } from './cost-center-usage.registry.js';
import { CostCentersController } from './cost-centers.controller.js';
import { CostCentersService } from './cost-centers.service.js';

/**
 * Cost centres (ADR-024 §1). Depends on no business module: the journal
 * (posting checks) and the document modules (header centre) import it, and
 * register their "centre in use" checks with CostCenterUsageRegistry.
 */
@Module({
  imports: [SharedModule],
  controllers: [CostCentersController],
  providers: [CostCentersService, CostCenterUsageRegistry],
  exports: [CostCentersService, CostCenterUsageRegistry],
})
export class CostCentersModule {}
