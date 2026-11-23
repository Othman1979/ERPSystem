import { ApiProperty } from '@nestjs/swagger';
import { ConsignmentSaleSourceType } from '../../../generated/prisma/enums.js';

export class ConsignmentItemResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  nameAr!: string;

  @ApiProperty({ type: String, nullable: true })
  nameEn!: string | null;
}

export class ConsignmentOpenSaleResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty()
  companyId!: string;

  @ApiProperty()
  warehouseId!: string;

  @ApiProperty()
  supplierId!: string;

  @ApiProperty()
  itemId!: string;

  @ApiProperty({ enum: ConsignmentSaleSourceType, enumName: 'ConsignmentSaleSourceType' })
  sourceType!: ConsignmentSaleSourceType;

  @ApiProperty()
  sourceId!: string;

  @ApiProperty()
  sourceLineId!: string;

  @ApiProperty({ type: String, format: 'date' })
  saleDate!: string;

  @ApiProperty()
  qty!: string;

  @ApiProperty()
  value!: string;

  @ApiProperty()
  returnedQty!: string;

  @ApiProperty()
  returnedValue!: string;

  @ApiProperty()
  invoicedQty!: string;

  @ApiProperty()
  invoicedValue!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty()
  openQty!: string;

  @ApiProperty()
  openValue!: string;

  @ApiProperty({ type: ConsignmentItemResponseDto })
  item!: ConsignmentItemResponseDto;
}

export class ConsignmentStatementResponseDto {
  @ApiProperty({ type: ConsignmentItemResponseDto })
  item!: ConsignmentItemResponseDto;

  @ApiProperty()
  receivedQty!: string;

  @ApiProperty()
  returnedToSupplierQty!: string;

  @ApiProperty()
  soldNetOfReturnsQty!: string;

  @ApiProperty()
  countShortageQty!: string;

  @ApiProperty()
  invoicedQty!: string;

  @ApiProperty()
  onHandQty!: string;

  @ApiProperty()
  openQty!: string;

  @ApiProperty()
  openValue!: string;
}

export class ConsignmentAgingResponseDto extends ConsignmentOpenSaleResponseDto {
  @ApiProperty()
  ageDays!: number;

  @ApiProperty({ enum: ['0-30', '31-60', '61-90', '90+'] })
  ageBucket!: string;
}
