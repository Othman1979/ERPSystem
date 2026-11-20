import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse } from '../../common/openapi/responses.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import type { ReportTable } from '../printing/report-table.js';
import {
  CreateEmployeeDto,
  CreatePayElementDto,
  CreatePayrollInputDto,
  CreatePayrollRunDto,
  CreatePayrollSettingsDto,
  CreateRecurringElementDto,
  CreateSalaryDto,
  ListPayrollInputsDto,
  PayrollPaymentDto,
  PayrollReportQueryDto,
  ReversePayrollDto,
  SetPayrollTaxDto,
} from './dto/payroll.dto.js';
import { PayrollRunDetailDto, PayrollRunDto } from './dto/payroll-response.dto.js';
import { PayrollService } from './payroll.service.js';

@ApiTags('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService, private readonly printing: PrintingService) {}

  @Get('employees')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  listEmployees() {
    return this.payroll.listEmployees();
  }

  @Post('employees')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse()
  createEmployee(@Body() dto: CreateEmployeeDto) {
    return this.payroll.createEmployee(dto);
  }

  @Post('employees/:id/salaries')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  addSalary(@Param('id') id: string, @Body() dto: CreateSalaryDto) {
    return this.payroll.addSalary(BigInt(id), dto);
  }

  @Get('employees/:id/recurring-elements')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  listRecurring(@Param('id') id: string) {
    return this.payroll.listRecurring(BigInt(id));
  }

  @Post('employees/:id/recurring-elements')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  createRecurring(@Param('id') id: string, @Body() dto: CreateRecurringElementDto) {
    return this.payroll.createRecurring(BigInt(id), dto);
  }

  @Get('elements')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  listElements() {
    return this.payroll.listElements();
  }

  @Post('elements')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  createElement(@Body() dto: CreatePayElementDto) {
    return this.payroll.createElement(dto);
  }

  @Get('settings')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  listSettings() {
    return this.payroll.listSettings();
  }

  @Post('settings')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  createSettings(@Body() dto: CreatePayrollSettingsDto) {
    return this.payroll.createSettings(dto);
  }

  @Get('inputs')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  listInputs(@Query() query: ListPayrollInputsDto) {
    return this.payroll.listInputs(query.period, query.employeeId);
  }

  @Post('inputs')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  createInput(@Body() dto: CreatePayrollInputDto) {
    return this.payroll.createInput(dto);
  }

  @Delete('inputs/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  deleteInput(@Param('id') id: string) {
    return this.payroll.deleteInput(BigInt(id));
  }

  @Get('runs')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  listRuns(): Promise<PayrollRunDto[]> {
    return this.payroll.listRuns();
  }

  @Post('runs')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse({ type: PayrollRunDetailDto })
  createRun(@Body() dto: CreatePayrollRunDto) {
    return this.payroll.createRun(dto.period);
  }

  @Get('runs/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollRunDetailDto })
  getRun(@Param('id') id: string) {
    return this.payroll.getRun(id);
  }

  @Post('runs/:id/recompute')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  recomputeRun(@Param('id') id: string) {
    return this.payroll.recomputeRun(BigInt(id));
  }

  @Patch('runs/:id/lines/:lineId/income-tax')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  setIncomeTax(@Param('id') id: string, @Param('lineId') lineId: string, @Body() dto: SetPayrollTaxDto) {
    return this.payroll.setIncomeTax(BigInt(id), BigInt(lineId), dto.incomeTax);
  }

  @Post('runs/:id/post')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @ApiOkResponse({ type: PayrollRunDetailDto })
  postRun(@Param('id') id: string) {
    return this.payroll.postRun(BigInt(id));
  }

  @Post('runs/:id/pay')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @ApiOkResponse({ type: PayrollRunDetailDto })
  payRun(@Param('id') id: string, @Body() dto: PayrollPaymentDto) {
    return this.payroll.payRun(BigInt(id), dto);
  }

  @Post('runs/:id/reverse')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @ApiOkResponse({ type: PayrollRunDetailDto })
  reverseRun(@Param('id') id: string, @Body() dto: ReversePayrollDto) {
    return this.payroll.reverseRun(BigInt(id), new Date(`${dto.date}T00:00:00.000Z`));
  }

  @Get('reports/register')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiFileResponse(['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  async registerReport(@Query() query: PayrollReportQueryDto) {
    const data = await this.payroll.getRun(query.period, true);
    return this.printing.respond(data, query, (report, lang): ReportTable => ({
      title: lang === 'ar' ? 'سجل الرواتب' : 'Payroll register',
      fileName: `payroll-register-${query.period}`,
      columns: [
        { key: 'employee', label: lang === 'ar' ? 'الموظف' : 'Employee' },
        { key: 'basic', label: lang === 'ar' ? 'الأساسي' : 'Basic', kind: 'amount' },
        { key: 'gross', label: lang === 'ar' ? 'الإجمالي' : 'Gross', kind: 'amount' },
        { key: 'ssc', label: lang === 'ar' ? 'الضمان' : 'SSC', kind: 'amount' },
        { key: 'tax', label: lang === 'ar' ? 'الضريبة' : 'Tax', kind: 'amount' },
        { key: 'net', label: lang === 'ar' ? 'الصافي' : 'Net', kind: 'amount' },
      ],
      rows: report.lines.map((line) => ({
        employee: line.employeeName,
        basic: line.basic,
        gross: line.gross,
        ssc: line.sscEmployee,
        tax: line.incomeTax,
        net: line.net,
      })),
      meta: [query.period],
    }));
  }

  @Get('reports/ssc')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiFileResponse(['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  async sscReport(@Query() query: PayrollReportQueryDto) {
    const data = await this.payroll.getRun(query.period, true);
    return this.printing.respond(data, query, (report, lang): ReportTable => ({
      title: lang === 'ar' ? 'كشف الضمان الاجتماعي الشهري' : 'Monthly SSC sheet',
      fileName: `payroll-ssc-${query.period}`,
      columns: [
        { key: 'employee', label: lang === 'ar' ? 'الموظف' : 'Employee' },
        { key: 'base', label: lang === 'ar' ? 'الأجر الخاضع' : 'Subject wage', kind: 'amount' },
        { key: 'employeeShare', label: lang === 'ar' ? 'حصة الموظف' : 'Employee share', kind: 'amount' },
        { key: 'employerShare', label: lang === 'ar' ? 'حصة الشركة' : 'Employer share', kind: 'amount' },
      ],
      rows: report.lines.map((line) => ({
        employee: line.employeeName,
        base: line.sscBase,
        employeeShare: line.sscEmployee,
        employerShare: line.sscEmployer,
      })),
      meta: [query.period],
    }));
  }

  @Get('reports/tax-withheld')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiFileResponse(['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  async taxReport(@Query() query: PayrollReportQueryDto) {
    const data = await this.payroll.getRun(query.period, true);
    return this.printing.respond(data, query, (report, lang): ReportTable => ({
      title: lang === 'ar' ? 'ضريبة الدخل المقتطعة' : 'Income tax withheld',
      fileName: `payroll-tax-${query.period}`,
      columns: [
        { key: 'employee', label: lang === 'ar' ? 'الموظف' : 'Employee' },
        { key: 'tax', label: lang === 'ar' ? 'المقتطع' : 'Withheld', kind: 'amount' },
      ],
      rows: report.lines.map((line) => ({ employee: line.employeeName, tax: line.incomeTax })),
      meta: [query.period],
    }));
  }

  @Get('runs/:id/lines/:lineId/payslip')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiFileResponse(['application/pdf'])
  async payslip(@Param('id') id: string, @Param('lineId') lineId: string, @Query('lang') lang?: string) {
    const run = await this.payroll.getRun(id);
    const line = run.lines.find((item) => item.id === lineId);
    if (!line) throw DomainError.notFound('PayrollLine', lineId);
    const language = lang === 'en' ? 'en' : 'ar';
    return this.printing.exportDocument({
      title: language === 'ar' ? 'قسيمة راتب' : 'Payslip',
      docNo: run.runNo,
      status: run.status === 'DRAFT' ? 'DRAFT' : 'POSTED',
      fileName: `payslip-${run.period}-${line.employeeId}`,
      fields: [
        { label: language === 'ar' ? 'الموظف' : 'Employee', value: line.employeeName },
        { label: language === 'ar' ? 'الفترة' : 'Period', value: run.period },
      ],
      lines: {
        columns: [
          { key: 'name', label: language === 'ar' ? 'البند' : 'Item' },
          { key: 'amount', label: language === 'ar' ? 'المبلغ' : 'Amount', kind: 'amount' },
        ],
        rows: [
          { name: language === 'ar' ? 'الراتب الأساسي' : 'Basic salary', amount: line.basic },
          { name: language === 'ar' ? 'الإضافات' : 'Earnings', amount: line.earnings },
          { name: language === 'ar' ? 'ضمان الموظف' : 'Employee SSC', amount: line.sscEmployee },
          { name: language === 'ar' ? 'ضريبة الدخل' : 'Income tax', amount: line.incomeTax },
          { name: language === 'ar' ? 'الاستقطاعات' : 'Deductions', amount: line.deductions },
        ],
      },
      totals: [{ label: language === 'ar' ? 'الصافي' : 'Net pay', value: line.net, strong: true }],
    }, language);
  }
}
