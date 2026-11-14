/**
 * Response shapes of the error-monitoring console routes (PLAT-15). They
 * describe what MonitoringService returns today; nothing here changes a body.
 */
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { ErrorEventRow } from '../../../common/openapi/prisma-models.js';

/**
 * An error as the console lists it (MonitoringService `wire`): the stored
 * event without the fingerprint, the stack and the digest mark.
 */
export class AdminErrorRowDto extends OmitType(ErrorEventRow, ['fingerprint', 'stack', 'notifiedAt'] as const) {}

/** One error with its stack trace (MonitoringService.get; also what resolve and reopen return). */
export class AdminErrorDetailDto extends AdminErrorRowDto {
  @ApiProperty({ type: 'string', nullable: true })
  stack!: string | null;
}
