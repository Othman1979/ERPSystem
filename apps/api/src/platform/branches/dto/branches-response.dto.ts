/**
 * Response shapes of the branches routes (PLAT-15). They describe what
 * BranchesService returns today; nothing here changes a body.
 */
import { ApiProperty } from '@nestjs/swagger';

/** A branch (BranchesService.serialize): the public columns only, no tenant or audit ids. */
export class BranchDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  address!: string | null;

  @ApiProperty({ type: 'boolean' })
  isActive!: boolean;

  @ApiProperty({ type: 'string' })
  companyId!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  updatedAt!: string;
}
