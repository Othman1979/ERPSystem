import { Body, Controller, Get, Headers, Injectable, Module, type OnModuleInit, Put } from '@nestjs/common';
import { ApiExcludeController, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import {
  type OpenCycleDocumentsCounter,
  ProcurementCycleRegistry,
} from '../../common/procurement/procurement-level.js';

/**
 * A route that fails on purpose, so the e2e tests can watch a real server
 * fault reach the error monitor (ADR-010 §10.3). AppModule imports this
 * module only when NODE_ENV=test: it does not exist in development or
 * production builds' running servers.
 */
@ApiExcludeController()
@Controller('__test')
class TestSupportController {
  @Get('boom')
  boom(): never {
    // A secret-looking value, to prove the monitor redacts before storing.
    throw new TypeError('boom password=hunter2 for invoice 42');
  }

  /** 200 from a route the OpenAPI document leaves out: the response audit must record it. */
  @Get('undocumented')
  undocumented() {
    return { ok: true };
  }
}

/** The shape the contract-mismatch route declares (an amount as a decimal string). */
class TestSupportAmountDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  amount!: string;
}

/**
 * Documented test routes (NODE_ENV=test only, so they appear in that
 * server's document and never in the generated client): one answers what it
 * declares, one does not, so the e2e contract suite can prove the response
 * audit catches a wrong declaration (PLAT-15).
 */
@ApiTags('test-support')
@Controller('__test/contract')
class TestContractController {
  @Get('match')
  @ApiOkResponse({ type: TestSupportAmountDto })
  match() {
    return { amount: '1.500' };
  }

  /**
   * Answers wrongly only when the caller asks (the x-contract-mismatch
   * header, left out of the document): the isolation sweep calls every
   * documented GET, and must get a correct answer here.
   */
  @Get('mismatch')
  @ApiOkResponse({ type: TestSupportAmountDto })
  mismatch(@Headers('x-contract-mismatch') wrong?: string) {
    // A number where a string is declared, and a key that is not declared.
    return wrong === 'yes' ? { amount: 1.5, extra: true } : { amount: '1.500' };
  }
}

/**
 * A test-only open cycle documents counter (ADR-024 §2.2): the registry ships
 * empty in phase 11, so the e2e suite sets a count per tenant here to prove a
 * lowering is refused, and that tenant B is not affected by A's count.
 */
@Injectable()
export class TestOpenCycleCounter implements OpenCycleDocumentsCounter, OnModuleInit {
  readonly key = 'testDocuments';
  private readonly byTenant = new Map<bigint, number>();

  constructor(private readonly registry: ProcurementCycleRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  set(tenantId: bigint, count: number): void {
    this.byTenant.set(tenantId, count);
  }

  count(): Promise<number> {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    return Promise.resolve(tenantId === undefined ? 0 : (this.byTenant.get(tenantId) ?? 0));
  }
}

class TestOpenDocumentsDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  @IsInt()
  @Min(0)
  count!: number;
}

class TestOpenDocumentsResultDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  count!: number;
}

class TestPermissionCheckDto {
  @ApiProperty({ type: 'boolean', enum: [true] })
  ok!: true;
}

/**
 * Procurement test routes (NODE_ENV=test only): the open-documents count of
 * the caller's tenant (from CLS, never from the body), and a route guarded by
 * purchase.approve that proves TenantGuard unions member permissions.
 */
@ApiTags('test-support')
@Controller('__test/procurement')
class TestProcurementController {
  constructor(private readonly counter: TestOpenCycleCounter) {}

  @Put('open-documents')
  @ApiOkResponse({ type: TestOpenDocumentsResultDto })
  setOpenDocuments(@Body() dto: TestOpenDocumentsDto) {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (tenantId === undefined) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    this.counter.set(tenantId, dto.count);
    return { count: dto.count };
  }

  @Get('approve-check')
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiOkResponse({ type: TestPermissionCheckDto })
  approveCheck() {
    return { ok: true as const };
  }
}

@Module({
  controllers: [TestSupportController, TestContractController, TestProcurementController],
  providers: [TestOpenCycleCounter],
})
export class TestSupportModule {}
