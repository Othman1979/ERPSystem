import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  Matches,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

export const DOCUMENT_LOCK_DOC_TYPES = [
  'JOURNAL_ENTRY',
  'RECEIPT',
  'PAYMENT',
  'SALES_INVOICE',
  'PURCHASE_INVOICE',
] as const;

export type DocumentLockDocType = (typeof DOCUMENT_LOCK_DOC_TYPES)[number];

@ValidatorConstraint({ name: 'DocumentLockIdRange', async: false })
class DocumentLockIdRange implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(value) &&
      BigInt(value) <= 9223372036854775807n;
  }
}

export class DocumentLockParamsDto {
  @ApiProperty({ enum: DOCUMENT_LOCK_DOC_TYPES })
  @IsIn(DOCUMENT_LOCK_DOC_TYPES)
  docType!: DocumentLockDocType;

  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' })
  @Matches(/^[1-9][0-9]{0,18}$/)
  @Validate(DocumentLockIdRange)
  id!: string;
}

export class DocumentLockLeaseDto {
  @ApiProperty({ format: 'date-time' })
  acquiredAt!: Date;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;
}

export class DocumentLockHolderDto {
  @ApiProperty()
  userName!: string;

  @ApiProperty({ format: 'date-time' })
  acquiredAt!: Date;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;

  @ApiProperty()
  mine!: boolean;
}

export class DocumentLockStatusDto {
  @ApiProperty({ type: DocumentLockHolderDto, nullable: true })
  holder!: DocumentLockHolderDto | null;
}

export class DocumentLockForceReleaseDto {
  @ApiProperty()
  released!: boolean;
}
