import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module.js';
import { EInvoiceOutboxService } from './einvoice-outbox.service.js';

/**
 * The part of e-invoicing the sales module calls while posting (checks and
 * the outbox). Kept apart from EInvoiceModule, which reads the sales
 * documents to build them, so the two modules don't import each other.
 */
@Module({
  imports: [SharedModule],
  providers: [EInvoiceOutboxService],
  exports: [EInvoiceOutboxService],
})
export class EInvoiceOutboxModule {}
