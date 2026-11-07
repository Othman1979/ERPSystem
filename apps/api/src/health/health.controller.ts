import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/auth.decorators.js';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { PrismaService } from '../prisma/prisma.service.js';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness + database connectivity check' })
  async health(): Promise<{ status: string; db: string; timestamp: string }> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
    } catch {
      throw new DomainError(ErrorCode.DB_UNAVAILABLE, 'Database is not reachable');
    }
    return { status: 'ok', db: 'up', timestamp: new Date().toISOString() };
  }
}
