import { Module } from '@nestjs/common';
import { DocumentLocksController } from './document-locks.controller.js';
import { DocumentLocksService } from './document-locks.service.js';

@Module({
  controllers: [DocumentLocksController],
  providers: [DocumentLocksService],
  exports: [DocumentLocksService],
})
export class DocumentLocksModule {}
