/**
 * Response shapes of the health routes (PLAT-15). They describe what
 * HealthController returns on success. A failed probe answers with the standard
 * error envelope (ErrorResponseDto, 503), which main.ts documents for every route.
 */
import { ApiProperty } from '@nestjs/swagger';

/** The probes that passed: the database write and the temp directory (db-probe.ts). */
export class HealthChecksDto {
  @ApiProperty({ type: 'string', enum: ['ok'] })
  write!: 'ok';

  /** 'skipped' when the database host has no temp directory to test. */
  @ApiProperty({ type: 'string', enum: ['ok', 'skipped'] })
  tmpdir!: 'ok' | 'skipped';
}

/** Body of GET /health when the database can write (HealthController.health). */
export class HealthReportDto {
  @ApiProperty({ type: 'string', enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ type: 'string', enum: ['up'] })
  db!: 'up';

  @ApiProperty({ type: 'string', format: 'date-time' })
  timestamp!: string;

  @ApiProperty({ type: () => HealthChecksDto })
  checks!: HealthChecksDto;
}

/** Body of GET /health/live: the process answers (HealthController.live). */
export class HealthLiveDto {
  @ApiProperty({ type: 'string', enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ type: 'string', format: 'date-time' })
  timestamp!: string;
}
