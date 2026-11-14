import { Controller, Get, Logger } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/auth.decorators.js';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type DbProbeResult, probeDatabase } from './db-probe.js';
import { HealthLiveDto, HealthReportDto } from './health-response.dto.js';

/** Longest the readiness check may take: a load balancer gives up around there. */
const PROBE_TIMEOUT_MS = 2000;
/**
 * A probe result is reused this long: /health is public, and each probe writes
 * a row (rolled back) and an on-disk temp table, so callers cannot make the
 * database do that on every request. A monitor polling every minute still sees
 * every outage.
 */
const PROBE_CACHE_MS = 5000;

@ApiTags('health')
@Controller()
export class HealthController {
  /** The probe running now: concurrent checks share it instead of each writing a row. */
  private inFlight: Promise<DbProbeResult> | null = null;
  /** The last finished probe and when it finished. */
  private last: { result: DbProbeResult; at: number } | null = null;
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Readiness (PLAT-31): the database must WRITE and use its temp directory,
   * not just answer `SELECT 1` (a full disk still answers that).
   */
  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Readiness: the database can write and use its temp directory' })
  @ApiOkResponse({ type: HealthReportDto })
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
  @ApiOkResponse({ type: HealthLiveDto })
  live(): { status: string; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  private probe(): Promise<DbProbeResult> {
    if (this.last && Date.now() - this.last.at < PROBE_CACHE_MS) return Promise.resolve(this.last.result);
    this.inFlight ??= probeDatabase(
      // systemPrisma: a connectivity and write probe, no table of a tenant and no tenant id.
      this.prisma.client,
      PROBE_TIMEOUT_MS,
    )
      .then((result) => {
        this.last = { result, at: Date.now() };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
