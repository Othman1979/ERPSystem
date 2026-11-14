/**
 * Response shapes of the company routes (PLAT-15). They describe what
 * CompanyService returns today; nothing here changes a body.
 */
import { ApiProperty } from '@nestjs/swagger';

/** The logo as CompanyService.get shows it: attachment metadata, no bytes. */
export class CompanyLogoDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  fileName!: string;

  @ApiProperty({ type: 'string' })
  mimeType!: string;

  @ApiProperty({ type: 'string', nullable: true })
  sizeBytes!: string | null;
}

/** The company profile (CompanyService.get, update, uploadLogo, removeLogo, completeOnboarding). */
export class CompanyDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  legalNameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  legalNameEn!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  taxNumber!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  commercialRegistration!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  address!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  phone!: string | null;

  @ApiProperty({ type: 'boolean' })
  pricesIncludeTax!: boolean;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true, description: 'Set when the setup wizard is finished.' })
  onboardingCompletedAt!: string | null;

  @ApiProperty({ type: () => CompanyLogoDto, nullable: true })
  logo!: CompanyLogoDto | null;
}

/** The logo bytes (CompanyService.logo), base64-encoded. */
export class CompanyLogoBase64Dto {
  @ApiProperty({ type: 'string' })
  mimeType!: string;

  @ApiProperty({ type: 'string', description: 'Base64 of the image bytes.' })
  base64!: string;
}
