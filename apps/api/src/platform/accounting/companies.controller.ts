import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { CompaniesService } from './companies.service.js';
import { CompanyEntryDto, CreateCompanyDto, UpdateCompanyEntryDto } from './dto/companies.dto.js';

/** ADR-040: the tenant's companies; the request's company is X-Company-Id (CompanyGuard). */
@ApiTags('companies')
@Controller()
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get('companies')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: CompanyEntryDto, isArray: true })
  list() {
    return this.companies.list();
  }

  @Post('companies')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiCreatedResponse({ type: CompanyEntryDto })
  create(@Body() dto: CreateCompanyDto) {
    return this.companies.create(dto);
  }

  @Patch('companies/:id')
  @RequirePermission(PERMISSIONS.USER_MANAGE)
  @ApiOkResponse({ type: CompanyEntryDto })
  update(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateCompanyEntryDto) {
    return this.companies.update(BigInt(id), dto);
  }
}
