/**
 * Response shapes of the e-invoice routes (PLAT-15). They describe what
 * EInvoiceSettingsService / EInvoiceSubmissionsService return today; nothing
 * here changes a body.
 */
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { PageOf } from '../../../common/openapi/responses.js';
import { EInvoiceAttemptRow, EInvoiceSubmissionRow } from '../../../common/openapi/prisma-models.js';
import { EInvoiceEnvironment, EInvoiceTrack } from '../../../generated/prisma/enums.js';

/**
 * Columns every submission list row and detail carry (LIST_SELECT, einvoice-submissions.service.ts),
 * except `errors`, which each class declares with its real shape (the column is Json).
 */
const SUBMISSION_LIST_FIELDS = [
  'id',
  'documentType',
  'documentId',
  'documentNo',
  'uuid',
  'icv',
  'environment',
  'status',
  'attemptCount',
  'sentAt',
  'completedAt',
  'createdAt',
  'updatedAt',
] as const;

/**
 * One entry of a submission's `errors` column (einvoice-sender.service.ts):
 * JoFotara's errors or warnings, or a local validation or sending problem.
 */
export class EInvoiceErrorDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  message!: string;

  @ApiProperty({ type: 'string', enum: ['jofotara', 'local'] })
  source!: 'jofotara' | 'local';

  @ApiPropertyOptional({ type: 'string', description: "JoFotara's category of a warning, when it sends one." })
  category?: string;
}

const ERRORS = {
  type: () => EInvoiceErrorDto,
  isArray: true,
  nullable: true,
  description: 'Null when there is nothing to report.',
} as const;

/**
 * The e-invoice state of a sales document (EInvoiceOutboxService.stateOf):
 * `null` on the document when it was never queued.
 */
export class EInvoiceStateDto extends PickType(EInvoiceSubmissionRow, [
  'id',
  'status',
  'uuid',
  'icv',
  'environment',
  'qrPayload',
  'completedAt',
] as const) {
  @ApiProperty(ERRORS)
  errors!: EInvoiceErrorDto[] | null;
}

/** The JoFotara settings as the screen sees them (EInvoiceSettingsService.view). The secret itself is never returned. */
export class EInvoiceSettingsViewDto {
  @ApiProperty({ type: 'string', nullable: true })
  sellerTaxNumber!: string | null;

  @ApiProperty({ type: 'string', nullable: true, description: 'Legal name of the company (Arabic).' })
  sellerName!: string | null;

  @ApiProperty({ enum: EInvoiceEnvironment, enumName: 'EInvoiceEnvironment' })
  environment!: EInvoiceEnvironment;

  @ApiProperty({ type: 'string', nullable: true })
  baseUrl!: string | null;

  @ApiProperty({ type: 'string', description: 'The sandbox URL used when no base URL is set.' })
  defaultSandboxUrl!: string;

  @ApiProperty({ type: 'string', nullable: true })
  clientId!: string | null;

  @ApiProperty({ type: 'boolean', description: 'Whether a client secret is stored (the value is never returned).' })
  hasSecret!: boolean;

  @ApiProperty({ type: 'string', nullable: true })
  incomeSourceSequence!: string | null;

  @ApiProperty({ enum: EInvoiceTrack, enumName: 'EInvoiceTrack' })
  track!: EInvoiceTrack;

  @ApiProperty({ type: 'integer', minimum: 1, description: 'The ICV the next invoice will receive.' })
  nextIcv!: number;

  @ApiProperty({ type: 'boolean' })
  isEnabled!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  enabledAt!: string | null;

  @ApiProperty({ type: 'boolean', description: 'Whether the server has an encryption key for the stored secret.' })
  encryptionKeySet!: boolean;
}

/** One submission row of the follow-up list (LIST_SELECT). */
export class EInvoiceSubmissionListItemDto extends PickType(EInvoiceSubmissionRow, SUBMISSION_LIST_FIELDS) {
  @ApiProperty(ERRORS)
  errors!: EInvoiceErrorDto[] | null;
}

/** The submissions page: the numbered page plus a count per status over the same branches. */
export class EInvoiceSubmissionPageDto extends PageOf(EInvoiceSubmissionListItemDto) {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: "Submissions per status over the caller's branches, ignoring the status filter. Only statuses with rows appear.",
  })
  counts!: Record<string, number>;
}

/** The submission this one was rebuilt from (resend keeps the UUID and ICV). */
export class EInvoiceSubmissionOriginalDto extends PickType(EInvoiceSubmissionRow, ['id', 'documentNo', 'status'] as const) {}

/** One send attempt of a submission (EInvoiceSubmissionsService.get; the response body is not selected). */
export class EInvoiceSubmissionAttemptDto extends PickType(EInvoiceAttemptRow, [
  'attemptNo',
  'outcome',
  'httpStatus',
  'message',
  'startedAt',
  'finishedAt',
] as const) {}

/** One submission with what JoFotara answered and its attempts (EInvoiceSubmissionsService.get). */
export class EInvoiceSubmissionDetailDto extends PickType(EInvoiceSubmissionRow, [
  ...SUBMISSION_LIST_FIELDS,
  'qrPayload',
  'governmentUuid',
  'requestXml',
  'responseCode',
  'responseBody',
] as const) {
  @ApiProperty(ERRORS)
  errors!: EInvoiceErrorDto[] | null;

  @ApiProperty({ type: () => EInvoiceSubmissionOriginalDto, nullable: true })
  originalSubmission!: EInvoiceSubmissionOriginalDto | null;

  @ApiProperty({ type: () => EInvoiceSubmissionAttemptDto, isArray: true, description: 'Ordered by attemptNo ascending.' })
  attempts!: EInvoiceSubmissionAttemptDto[];
}
