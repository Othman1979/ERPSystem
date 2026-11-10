import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const AMOUNT = /^[0-9]+(\.[0-9]+)?$/;

/** Target opening balance of an account: one side, or neither to clear it. */
export class SetAccountOpeningDto {
  @IsOptional()
  @IsString()
  @Matches(AMOUNT)
  debit?: string;

  @IsOptional()
  @IsString()
  @Matches(AMOUNT)
  credit?: string;
}

/** Target opening balance of a customer or supplier on its control account. */
export class SetPartyOpeningDto extends SetAccountOpeningDto {
  @IsIn(['CUSTOMER', 'SUPPLIER'])
  partyType!: 'CUSTOMER' | 'SUPPLIER';
}
