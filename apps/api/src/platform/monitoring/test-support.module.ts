import { Controller, Get, Headers, Module } from '@nestjs/common';
import { ApiExcludeController, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';

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

@Module({ controllers: [TestSupportController, TestContractController] })
export class TestSupportModule {}
