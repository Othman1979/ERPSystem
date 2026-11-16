import { Module } from '@nestjs/common';
import { PrintingModule } from '../printing/printing.module.js';
import { BomService } from './bom.service.js';
import { BomsController } from './boms.controller.js';

/** Phase 16 (ADR-031): bills of materials. Production vouchers join in part B. */
@Module({
  imports: [PrintingModule],
  controllers: [BomsController],
  providers: [BomService],
  exports: [BomService],
})
export class ManufacturingModule {}
