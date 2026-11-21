import { Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  DocumentLockLeaseDto,
  DocumentLockParamsDto,
  DocumentLockStatusDto,
  DocumentLockForceReleaseDto,
} from './document-locks.dto.js';
import { DocumentLocksService } from './document-locks.service.js';

@ApiTags('document-locks')
@Controller('document-locks')
export class DocumentLocksController {
  constructor(private readonly locks: DocumentLocksService) {}

  @Post(':docType/:id/acquire')
  @ApiCreatedResponse({ type: DocumentLockLeaseDto })
  acquire(
    @Param() params: DocumentLockParamsDto,
    @Headers('x-edit-lock') token?: string,
  ) {
    return this.locks.acquire(params.docType, BigInt(params.id), token);
  }

  @Post(':docType/:id/heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: DocumentLockLeaseDto })
  heartbeat(
    @Param() params: DocumentLockParamsDto,
    @Headers('x-edit-lock') token?: string,
  ) {
    return this.locks.heartbeat(params.docType, BigInt(params.id), token);
  }

  @Delete(':docType/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async release(
    @Param() params: DocumentLockParamsDto,
    @Headers('x-edit-lock') token?: string,
  ): Promise<void> {
    await this.locks.release(params.docType, BigInt(params.id), token);
  }

  @Post(':docType/:id/force-release')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.DOCUMENT_UNLOCK)
  @ApiOkResponse({ type: DocumentLockForceReleaseDto })
  forceRelease(@Param() params: DocumentLockParamsDto) {
    return this.locks.forceRelease(params.docType, BigInt(params.id));
  }

  @Get(':docType/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: DocumentLockStatusDto })
  status(@Param() params: DocumentLockParamsDto) {
    return this.locks.status(params.docType, BigInt(params.id));
  }
}
