import { IsIn, IsOptional } from 'class-validator';

/** `?format=json|pdf|xlsx&lang=ar|en` on every report (BUILD_PLAN §15). */
export class ExportQueryDto {
  @IsOptional()
  @IsIn(['json', 'pdf', 'xlsx'])
  format?: 'json' | 'pdf' | 'xlsx';

  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';
}
