import { Module } from '@nestjs/common';
import { DocumentSupportService } from './document-support.service.js';

@Module({
  providers: [DocumentSupportService],
  exports: [DocumentSupportService],
})
export class SharedModule {}
