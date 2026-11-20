import { ApiProperty } from '@nestjs/swagger';
import { CHEQUE_DIRECTIONS, CHEQUE_STATUSES } from './cheques.dto.js';

class ChequeRefDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', nullable: true }) nameEn!: string | null;
}

export class ChequeDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', enum: CHEQUE_DIRECTIONS }) direction!: (typeof CHEQUE_DIRECTIONS)[number];
  @ApiProperty({ type: 'string', enum: CHEQUE_STATUSES }) status!: (typeof CHEQUE_STATUSES)[number];
  @ApiProperty({ type: 'string' }) chequeNo!: string;
  @ApiProperty({ type: 'string', nullable: true }) bankName!: string | null;
  @ApiProperty({ type: 'string', format: 'date' }) dueDate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) amount!: string;
  @ApiProperty({ type: 'string', enum: ['CUSTOMER', 'SUPPLIER'] }) partyType!: 'CUSTOMER' | 'SUPPLIER';
  @ApiProperty({ type: ChequeRefDto }) party!: ChequeRefDto;
  @ApiProperty({ type: ChequeRefDto, nullable: true }) bankAccount!: ChequeRefDto | null;
  @ApiProperty({ type: 'string', nullable: true }) voucherNo!: string | null;
  @ApiProperty({ type: 'string', format: 'date', nullable: true }) voucherDate!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) receiptId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) paymentId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) branchId!: string | null;
}

export class ChequePageDto {
  @ApiProperty({ type: ChequeDto, isArray: true }) items!: ChequeDto[];
  @ApiProperty({ type: 'integer' }) page!: number;
  @ApiProperty({ type: 'integer' }) pageSize!: number;
  @ApiProperty({ type: 'integer' }) total!: number;
  @ApiProperty({ type: 'string', format: 'decimal' }) totalAmount!: string;
}

class EntryRefDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', nullable: true }) entryNo!: string | null;
}

export class ChequeEventDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', enum: ['RECEIVE', 'ISSUE', 'DEPOSIT', 'COLLECT', 'CLEAR', 'RETURN', 'CANCEL'] })
  action!: string;
  @ApiProperty({ type: 'string', nullable: true }) fromStatus!: string | null;
  @ApiProperty({ type: 'string' }) toStatus!: string;
  @ApiProperty({ type: 'string', format: 'date' }) eventDate!: string;
  @ApiProperty({ type: 'string', nullable: true }) bankAccountId!: string | null;
  @ApiProperty({ type: EntryRefDto, nullable: true }) journalEntry!: EntryRefDto | null;
  @ApiProperty({ type: EntryRefDto, nullable: true }) undoEntry!: EntryRefDto | null;
  @ApiProperty({ type: 'string', nullable: true }) notes!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) undoneAt!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: string;
}

export class ChequeDetailDto extends ChequeDto {
  @ApiProperty({ type: ChequeEventDto, isArray: true }) events!: ChequeEventDto[];
}

export class ChequeOutstandingDto {
  @ApiProperty({ type: ChequeDto, isArray: true }) items!: ChequeDto[];
  @ApiProperty({ type: 'string', format: 'decimal' }) incomingTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) outgoingTotal!: string;
}
