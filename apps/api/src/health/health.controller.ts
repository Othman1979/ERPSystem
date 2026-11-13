import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/auth.decorators.js';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type DbProbeResult, probeDatabase } from './db-probe.js';

/** Longest the readiness check may take: a load balancer gives up around there. */
const PROBE_TIMEOUT_MS = 2000;

@ApiTags('health')
@Controller()
export class HealthController {
  /** The probe running now: concurrent checks share it instead of each writing a row. */
  private inFlight: Promise<DbProbeResult> | null = null;
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Readiness (PLAT-31): the database must WRITE and use its temp directory,
   * not just answer `SELECT 1` (a full disk still answers that).
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Readiness: the database can write and use its temp directory' })
  async health(): Promise<{
    status: string;
    db: string;
    timestamp: string;
    checks: { write: string; tmpdir: string };
  }> {
    const result = await this.probe();
    if (!result.ok) {
      // The reason (errno, server message) goes to the host's log, not to an
      // unauthenticated caller.
      this.logger.error(`Readiness probe failed: ${result.reason}`);
      throw new DomainError(ErrorCode.DB_UNAVAILABLE, 'Database cannot write');
    }
    return {
      status: 'ok',
      db: 'up',
      timestamp: new Date().toISOString(),
      checks: { write: 'ok', tmpdir: result.tmpdir },
    };
  }

  /** Liveness: the process answers. It never touches the database, so a DB outage does not restart the process. */
  @Public()
  @Get('health/live')
  @ApiOperation({ summary: 'Liveness: the process answers (no database access)' })
  live(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  private probe(): Promise<DbProbeResult> {
    this.inFlight ??= probeDatabase(
      // systemPrisma: a connectivity and write probe, no table of a tenant and no tenant id.
      this.prisma.client,
      PROBE_TIMEOUT_MS,
    ).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}
