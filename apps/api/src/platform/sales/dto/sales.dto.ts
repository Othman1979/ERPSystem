import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const PAYMENT_TYPES = ['CASH', 'CREDIT'] as const;
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const MONEY = /^\d+(\.\d{1,3})?$/;
const INT_STRING = /^\d+$/;

export class SalesInvoiceLineDto {
  @IsString()
  @Matches(INT_STRING)
  itemId!: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  itemUnitId?: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;

  @IsString()
  @Matches(MONEY)
  unitPrice!: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  discountPct?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  taxCategoryId?: string;
}

export class CreateSalesInvoiceDto {
  @IsDateString()
  invoiceDate!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsString()
  @Matches(INT_STRING)
  customerId!: string;

  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

  @IsIn(PAYMENT_TYPES)
  paymentType!: (typeof PAYMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  cashAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesInvoiceLineDto)
  lines!: SalesInvoiceLineDto[];
}

export class SalesReturnLineDto {
  @IsString()
  @Matches(INT_STRING)
  originalLineId!: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;
}

export class CreateSalesReturnDto {
  @IsDateString()
  returnDate!: string;

  @IsString()
  @Matches(INT_STRING)
  originalInvoiceId!: string;

  @IsIn(PAYMENT_TYPES)
  refundType!: (typeof PAYMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  cashAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesReturnLineDto)
  lines!: SalesReturnLineDto[];
}
