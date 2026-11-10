import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module.js';
import { PrintingService } from './printing.service.js';

/** PDF / XLSX output (Phase 8). Depends on no business module. */
@Module({
  imports: [SharedModule],
  providers: [PrintingService],
  exports: [PrintingService],
})
export class PrintingModule {}
