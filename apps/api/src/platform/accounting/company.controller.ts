import { Body, Controller, Delete, Get, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CompanyService, type UploadedFileLike } from './company.service.js';
import { UpdateCompanyDto } from './dto/company.dto.js';
import { CompanyDto, CompanyLogoBase64Dto } from './dto/company-response.dto.js';

/** The company profile and the setup wizard state (§13.4). */
@ApiTags('company')
@Controller('company')
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: CompanyDto })
  get() {
    return this.company.get();
  }

  @Patch()
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOkResponse({ type: CompanyDto })
  update(@Body() dto: UpdateCompanyDto) {
    return this.company.update(dto);
  }

  @Get('logo')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: CompanyLogoBase64Dto })
  logo() {
    return this.company.logo();
  }

  /** multipart/form-data with `file`: PNG or JPEG up to 1 MB (5 MB hard cap on the request). */
  @Post('logo')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @ApiCreatedResponse({ type: CompanyDto })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  uploadLogo(@UploadedFile() file: UploadedFileLike | undefined) {
    return this.company.uploadLogo(file);
  }

  @Delete('logo')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @ApiOkResponse({ type: CompanyDto })
  removeLogo() {
    return this.company.removeLogo();
  }

  @Post('onboarding/complete')
  @RequirePermission(PERMISSIONS.SETTINGS_MANAGE)
  @ApiCreatedResponse({ type: CompanyDto })
  completeOnboarding() {
    return this.company.completeOnboarding();
  }
}
