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

export class PurchaseInvoiceLineDto {
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
  unitCost!: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  discountPct?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  taxCategoryId?: string;
}

export class CreatePurchaseInvoiceDto {
  @IsDateString()
  invoiceDate!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsString()
  @Matches(INT_STRING)
  supplierId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNo?: string;

  @IsOptional()
  @IsDateString()
  supplierInvoiceDate?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  warehouseId?: string;

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
  @Type(() => PurchaseInvoiceLineDto)
  lines!: PurchaseInvoiceLineDto[];
}

export class PurchaseReturnLineDto {
  @IsString()
  @Matches(INT_STRING)
  originalLineId!: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;
}

export class CreatePurchaseReturnDto {
  @IsDateString()
  returnDate!: string;

  @IsString()
  @Matches(INT_STRING)
  originalInvoiceId!: string;

  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

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
  @Type(() => PurchaseReturnLineDto)
  lines!: PurchaseReturnLineDto[];
}
