import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse } from '../../common/openapi/responses.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import type { ReportTable } from '../printing/report-table.js';
import {
  CreateEmployeeDto,
  CreatePayElementDto,
  CreatePayrollMovementDto,
  CreatePayrollRunDto,
  CreatePayrollSettingsDto,
  CreateRecurringElementDto,
  CreateSalaryDto,
  EmployeeStatementExportQueryDto,
  EmployeeStatementQueryDto,
  ListPayrollMovementsDto,
  PayrollPaymentDto,
  PayrollReportQueryDto,
  ReversePayrollDto,
  SetPayrollTaxDto,
  UpdateEmployeeDto,
  UpdatePayElementDto,
} from './dto/payroll.dto.js';
import {
  PayrollElementDto,
  PayrollEmployeeDetailDto,
  PayrollEmployeeDto,
  PayrollEmployeeStatementDto,
  PayrollMovementDto,
  PayrollRunDetailDto,
  PayrollRunDto,
} from './dto/payroll-response.dto.js';
import { PayrollService } from './payroll.service.js';

@ApiTags('payroll')
@Controller('payroll')
@RequireAllBranches()
export class PayrollController {
  constructor(private readonly payroll: PayrollService, private readonly printing: PrintingService) {}

  @Get('employees')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollEmployeeDto, isArray: true })
  listEmployees() {
    return this.payroll.listEmployees();
  }

  @Get('employees/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollEmployeeDetailDto })
  getEmployee(@Param('id') id: string) {
    return this.payroll.getEmployee(BigInt(id));
  }

  @Get('employees/:id/statement')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollEmployeeStatementDto })
  employeeStatement(@Param('id') id: string, @Query() query: EmployeeStatementQueryDto) {
    return this.payroll.employeeStatement(BigInt(id), query.from, query.to);
  }

  @Post('employees')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiCreatedResponse()
  createEmployee(@Body() dto: CreateEmployeeDto) {
    return this.payroll.createEmployee(dto);
  }

  @Patch('employees/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse({ type: PayrollEmployeeDetailDto })
  updateEmployee(@Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.payroll.updateEmployee(BigInt(id), dto);
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

  @Delete('employees/:id/recurring-elements/:rid')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse()
  deleteRecurring(@Param('id') id: string, @Param('rid') rid: string) {
    return this.payroll.deleteRecurring(BigInt(id), BigInt(rid));
  }

  @Get('elements')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollElementDto, isArray: true })
  listElements() {
    return this.payroll.listElements();
  }

  @Post('elements')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  createElement(@Body() dto: CreatePayElementDto) {
    return this.payroll.createElement(dto);
  }

  @Patch('elements/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse()
  updateElement(@Param('id') id: string, @Body() dto: UpdatePayElementDto) {
    return this.payroll.updateElement(BigInt(id), dto);
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

  @Get('movements')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiOkResponse({ type: PayrollMovementDto, isArray: true })
  listMovements(@Query() query: ListPayrollMovementsDto) {
    return this.payroll.listMovements(query.period, query.employeeId);
  }

  @Post('movements')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @ApiCreatedResponse({ type: PayrollMovementDto })
  createMovement(@Body() dto: CreatePayrollMovementDto) {
    return this.payroll.createMovement(dto);
  }

  @Post('movements/:id/reverse')
  @RequirePermission(PERMISSIONS.PAYROLL_POST)
  @RequiresIdempotencyKey()
  @ApiOkResponse({ type: PayrollMovementDto })
  reverseMovement(@Param('id') id: string, @Body() dto: ReversePayrollDto) {
    return this.payroll.reverseMovement(BigInt(id), new Date(`${dto.date}T00:00:00.000Z`));
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

  @Delete('runs/:id')
  @RequirePermission(PERMISSIONS.PAYROLL_MANAGE)
  @ApiOkResponse()
  deleteRun(@Param('id') id: string) {
    return this.payroll.deleteRun(BigInt(id));
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

  @Get('reports/employee-statement')
  @RequirePermission(PERMISSIONS.PAYROLL_VIEW)
  @ApiFileResponse(['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  async employeeStatementReport(@Query() query: EmployeeStatementExportQueryDto) {
    const statement = await this.payroll.employeeStatement(BigInt(query.employeeId), query.from, query.to);
    return this.printing.respond(statement, query, (report, lang): ReportTable => ({
      title: lang === 'ar' ? 'كشف حساب الموظف' : 'Employee statement',
      fileName: `employee-statement-${query.employeeId}-${query.from}-${query.to}`,
      columns: [
        { key: 'date', label: lang === 'ar' ? 'التاريخ' : 'Date' },
        { key: 'documentNo', label: lang === 'ar' ? 'رقم المستند' : 'Document no.' },
        { key: 'documentType', label: lang === 'ar' ? 'النوع' : 'Type' },
        { key: 'description', label: lang === 'ar' ? 'الوصف' : 'Description' },
        { key: 'debit', label: lang === 'ar' ? 'مدين' : 'Debit', kind: 'amount' },
        { key: 'credit', label: lang === 'ar' ? 'دائن' : 'Credit', kind: 'amount' },
        { key: 'balance', label: lang === 'ar' ? 'الرصيد' : 'Balance', kind: 'amount' },
      ],
      rows: report.rows,
      meta: [report.employeeName, report.from, report.to, report.openingBalance, report.closingBalance],
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
          ...line.items.map((item) => ({ name: item.description, amount: item.amount })),
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
