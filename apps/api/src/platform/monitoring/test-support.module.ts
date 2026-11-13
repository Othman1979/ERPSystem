import { Controller, Get, Module } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

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
}

@Module({ controllers: [TestSupportController] })
export class TestSupportModule {}
