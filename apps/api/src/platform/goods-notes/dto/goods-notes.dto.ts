import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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

const NOTE_TYPES = ['GRN', 'GIN'] as const;
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const MONEY = /^\d+(\.\d{1,3})?$/;
const INT_STRING = /^\d+$/;

export class GoodsNoteLineDto {
  @IsString()
  @Matches(INT_STRING)
  itemId!: string;

  /** Base-unit quantity. */
  @IsString()
  @Matches(DECIMAL)
  qty!: string;

  /**
   * Required for a GRN without a purchase order (receipt cost per base unit);
   * ignored for a GIN. Refused on a GRN against an order: its cost is the
   * order's net price (ADR-026 §5).
   */
  @IsOptional()
  @Matches(MONEY)
  unitCost?: string;

  /** ADR-026 §5: the order line this GRN line receives (a GRN with purchaseOrderId only). */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  poLineId?: string;

  /** ADR-026 §9: the request line this GIN line issues (a GIN with issueRequestId only). */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  issueRequestLineId?: string;
}

export class CreateGoodsNoteDto {
  @IsDateString()
  noteDate!: string;

  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

  @IsIn(NOTE_TYPES)
  noteType!: (typeof NOTE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /**
   * ADR-026 §5: a GRN against this approved purchase order: the order's
   * warehouse, every line naming an order line. Set at creation, never changed.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  purchaseOrderId?: string;

  /** ADR-026 §8: a GIN to a department debits this expense account instead of INVENTORY_ADJUSTMENT. */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  expenseAccountId?: string;

  /** ADR-026 §8: the department (a leaf cost centre) of a GIN. */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  costCenterId?: string;

  /**
   * ADR-026 §9: a GIN from this approved issue request (FULL level): its
   * warehouse, every line naming a request line. Set at creation, never changed.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  issueRequestId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsNoteLineDto)
  lines!: GoodsNoteLineDto[];
}

/** One order line received: its base quantity. */
export class ReceiveLineDto {
  @IsString()
  @Matches(INT_STRING)
  poLineId!: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;
}

/**
 * POST /purchase-orders/:id/receive: a draft GRN against the order (ADR-026 §5).
 * Without lines it takes what is left on every line.
 */
export class ReceivePurchaseOrderDto {
  @IsDateString()
  noteDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines?: ReceiveLineDto[];
}

/** One request line issued: its base quantity. */
export class IssueLineDto {
  @IsString()
  @Matches(INT_STRING)
  issueRequestLineId!: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;
}

/**
 * POST /issue-requests/:id/issue: a draft GIN from the approved request
 * (ADR-026 §9), with its department and expense account. Without lines it
 * takes what is left on every line.
 */
export class IssueFromRequestDto {
  @IsDateString()
  noteDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => IssueLineDto)
  lines?: IssueLineDto[];
}
