import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { EInvoiceController } from './einvoice.controller.js';
import { EInvoiceDocumentsService } from './einvoice-documents.service.js';
import { EInvoiceSenderService } from './einvoice-sender.service.js';
import { EInvoiceSettingsService } from './einvoice-settings.service.js';
import { EInvoiceSubmissionsService } from './einvoice-submissions.service.js';
import { EInvoiceWorker } from './einvoice-worker.service.js';

/**
 * Phase 7 — JoFotara (BUILD_PLAN §12, docs/decisions/0005): settings,
 * building documents from posted sales documents, the outbox worker and the
 * follow-up screen. Posting only touches EInvoiceOutboxModule.
 */
@Module({
  imports: [SharedModule, SalesModule],
  controllers: [EInvoiceController],
  providers: [
    EInvoiceSettingsService,
    EInvoiceDocumentsService,
    EInvoiceSenderService,
    EInvoiceSubmissionsService,
    EInvoiceWorker,
  ],
})
export class EInvoiceModule {}
