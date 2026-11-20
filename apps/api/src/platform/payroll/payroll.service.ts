import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { YearClosingDraftRegistry, yearClosingDraft } from '../accounting/year-closing-draft.registry.js';
import { CostCenterUsageRegistry } from '../cost-centers/cost-center-usage.registry.js';
import { isIncomeStatement } from '../cost-centers/cost-center-rules.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import {
  calculatePayroll,
  type PayrollElement,
  type PayrollElementEntry,
  type PayrollRecurringEntry,
} from './payroll-calculator.js';
import type {
  CreateEmployeeDto,
  CreatePayElementDto,
  CreatePayrollInputDto,
  CreatePayrollSettingsDto,
  CreateRecurringElementDto,
  CreateSalaryDto,
  PayrollPaymentDto,
} from './dto/payroll.dto.js';

const MAPPING_KEYS = [
  'PAYROLL_SALARIES_EXPENSE',
  'PAYROLL_SSC_EXPENSE',
  'PAYROLL_PAYABLE',
  'PAYROLL_SSC_PAYABLE',
  'PAYROLL_TAX_PAYABLE',
] as const;

function date(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function periodBounds(period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new DomainError(ErrorCode.VALIDATION, 'period must be YYYY-MM');
  }
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
  };
}

@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    yearClosingDrafts: YearClosingDraftRegistry,
    costCenterUsage: CostCenterUsageRegistry,
  ) {
    yearClosingDrafts.register('PAYROLL_RUN', async (tx, _tenantId, _companyId, from, to) => {
      const runs = await tx.payrollRun.findMany({
        where: { status: 'DRAFT', runDate: { gte: from, lte: to } },
        select: { id: true, runDate: true, runNo: true, period: true },
      });
      return runs.map((run) => yearClosingDraft('PAYROLL_RUN', run.id, run.runDate, run.runNo, `Payroll ${run.period}`));
    });
    costCenterUsage.register('payroll', async (tx, costCenterId) =>
      (await tx.employee.findFirst({ where: { costCenterId }, select: { id: true } })) ? 'employees' : null,
    );
  }

  private context() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const companyId = cls.get('companyId');
    if (!tenantId || !companyId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant/company selected');
    return { tenantId, companyId, db: this.prisma.forTenant(tenantId) };
  }

  private canManage() {
    const permissions = ClsServiceManager.getClsService<RequestContext>().get('permissions');
    if (!permissions?.has(PERMISSIONS.PAYROLL_MANAGE)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Missing payroll management permission');
    }
  }

  private canPost() {
    const permissions = ClsServiceManager.getClsService<RequestContext>().get('permissions');
    if (!permissions?.has(PERMISSIONS.PAYROLL_POST)) throw new DomainError(ErrorCode.FORBIDDEN, 'Missing payroll posting permission');
  }

  private async ensureDraftInputAllowed(tx: Prisma.TransactionClient, period: string) {
    const run = await tx.payrollRun.findFirst({
      where: { period, status: { in: ['POSTED', 'PAID'] } },
      select: { id: true },
    });
    if (run) throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Payroll inputs are locked after posting');
  }

  listEmployees() {
    const { db } = this.context();
    return db.employee.findMany({
      orderBy: [{ code: 'asc' }],
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        isActive: true,
        hireDate: true,
        leaveDate: true,
        branchId: true,
        costCenterId: true,
        payMethod: true,
        sscCovered: true,
        sscHazardous: true,
      },
    });
  }

  async createEmployee(dto: CreateEmployeeDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.employee.create({
      data: {
        tenantId,
        companyId,
        code: dto.code,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn ?? null,
        nationalId: dto.nationalId ?? null,
        sscNumber: dto.sscNumber ?? null,
        hireDate: date(dto.hireDate),
        leaveDate: dto.leaveDate ? date(dto.leaveDate) : null,
        branchId: dto.branchId ? BigInt(dto.branchId) : null,
        costCenterId: dto.costCenterId ? BigInt(dto.costCenterId) : null,
        payMethod: dto.payMethod,
        iban: dto.iban ?? null,
        sscCovered: dto.sscCovered ?? true,
        sscHazardous: dto.sscHazardous ?? false,
      },
    });
  }

  async addSalary(employeeId: bigint, dto: CreateSalaryDto) {
    this.canManage();
    const { tenantId, db } = this.context();
    const employee = await db.employee.findFirst({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
    return db.employeeSalary.create({
      data: { tenantId, employeeId, effectiveFrom: date(dto.effectiveFrom), basicSalary: dto.basicSalary },
    });
  }

  async listRecurring(employeeId: bigint) {
    const { db } = this.context();
    const employee = await db.employee.findFirst({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
    return db.employeeRecurringElement.findMany({
      where: { employeeId },
      include: { payElement: { select: { id: true, code: true, nameAr: true, amountType: true, kind: true } } },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    });
  }

  async createRecurring(employeeId: bigint, dto: CreateRecurringElementDto) {
    this.canManage();
    const { tenantId, db } = this.context();
    const employee = await db.employee.findFirst({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
    const element = await db.payElement.findFirst({ where: { id: BigInt(dto.payElementId), isActive: true } });
    if (!element) throw DomainError.notFound('PayElement', dto.payElementId);
    if (
      element.amountType === 'FIXED'
        ? dto.amount === undefined || dto.quantity !== undefined
        : dto.quantity === undefined || dto.amount !== undefined
    ) {
      throw new DomainError(ErrorCode.VALIDATION, 'Recurring value must match its pay element amount type');
    }
    const validFrom = date(dto.validFrom);
    const validTo = dto.validTo ? date(dto.validTo) : null;
    if (validTo && validTo < validFrom) throw new DomainError(ErrorCode.VALIDATION, 'validTo must not precede validFrom');
    return db.employeeRecurringElement.create({
      data: {
        tenantId,
        employeeId,
        payElementId: element.id,
        amount: dto.amount ?? null,
        quantity: dto.quantity ?? null,
        validFrom,
        validTo,
      },
    });
  }

  listElements() {
    const { db } = this.context();
    return db.payElement.findMany({ orderBy: [{ code: 'asc' }] });
  }

  async createElement(dto: CreatePayElementDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    const accountId = BigInt(dto.accountId);
    const account = await db.account.findFirst({ where: { id: accountId } });
    const cashOrBank = await db.cashBox.count({ where: { accountId } }) + await db.bankAccount.count({ where: { accountId } });
    const validType =
      dto.kind === 'EARNING'
        ? account?.accountType === 'EXPENSE'
        : account?.accountType === 'ASSET' || account?.accountType === 'LIABILITY';
    if (!account || !validType || account.isControl || !account.isPostable || !account.isActive || cashOrBank > 0) {
      throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'Pay element account is not allowed');
    }
    return db.payElement.create({
      data: {
        tenantId,
        companyId,
        code: dto.code,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn ?? null,
        kind: dto.kind,
        amountType: dto.amountType,
        rateFactor: dto.rateFactor,
        sscSubject: dto.sscSubject ?? true,
        accountId,
      },
    });
  }

  listSettings() {
    const { db } = this.context();
    return db.payrollSettings.findMany({ orderBy: [{ effectiveFrom: 'desc' }] });
  }

  async createSettings(dto: CreatePayrollSettingsDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.payrollSettings.create({
      data: {
        tenantId,
        companyId,
        effectiveFrom: date(dto.effectiveFrom),
        sscEmployeeRate: dto.sscEmployeeRate ?? '0.075000',
        sscEmployerRate: dto.sscEmployerRate ?? '0.142500',
        sscHazardousExtra: dto.sscHazardousExtra ?? '0.010000',
        sscMinWage: dto.sscMinWage ?? '290.000',
        sscMaxWage: dto.sscMaxWage ?? null,
        hoursPerMonth: dto.hoursPerMonth ?? '240.00',
        daysPerMonth: dto.daysPerMonth ?? '30.00',
      },
    });
  }

  async listInputs(period: string, employeeId?: string) {
    periodBounds(period);
    const { db } = this.context();
    return db.payrollInput.findMany({
      where: { period, ...(employeeId ? { employeeId: BigInt(employeeId) } : {}) },
      include: { employee: { select: { code: true, nameAr: true } }, payElement: { select: { code: true, nameAr: true } } },
      orderBy: [{ employeeId: 'asc' }, { workDate: 'asc' }, { id: 'asc' }],
    });
  }

  async createInput(dto: CreatePayrollInputDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await this.ensureDraftInputAllowed(tx, dto.period);
      const element = await tx.payElement.findFirst({
        where: { id: BigInt(dto.payElementId), isActive: true },
      });
      if (!element) throw DomainError.notFound('PayElement', dto.payElementId);
      if (element.amountType === 'FIXED' ? dto.amount === undefined : dto.quantity === undefined) {
        throw new DomainError(ErrorCode.VALIDATION, 'Input must match its pay element amount type');
      }
      return tx.payrollInput.create({
        data: {
          tenantId,
          companyId,
          employeeId: BigInt(dto.employeeId),
          payElementId: element.id,
          period: dto.period,
          workDate: dto.workDate ? date(dto.workDate) : null,
          quantity: dto.quantity ?? null,
          amount: dto.amount ?? null,
          note: dto.note ?? null,
        },
      });
    }, POSTING_TX_OPTIONS);
  }

  async deleteInput(id: bigint) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const input = await tx.payrollInput.findFirst({ where: { id } });
      if (!input) throw DomainError.notFound('PayrollInput', id.toString());
      await this.ensureDraftInputAllowed(tx, input.period);
      await tx.payrollInput.delete({ where: { id } });
      return { id: id.toString(), deleted: true };
    }, POSTING_TX_OPTIONS);
  }

  async createRun(period: string) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    const bounds = periodBounds(period);
    const runId = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const exists = await tx.payrollRun.findFirst({
        where: { period, status: { not: 'REVERSED' } },
        select: { id: true },
      });
      if (exists) throw new DomainError(ErrorCode.PAYROLL_RUN_EXISTS, 'Payroll run already exists');
      const run = await tx.payrollRun.create({
        data: { tenantId, companyId, period, runDate: bounds.end },
      });
      await this.computeRun(tx, tenantId, companyId, run.id, period, new Map());
      return run.id;
    }, POSTING_TX_OPTIONS);
    return this.getRun(runId.toString());
  }

  async recomputeRun(id: bigint) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft payroll runs can be recomputed');
      const oldLines = await tx.payrollLine.findMany({ where: { payrollRunId: id } });
      const taxes = new Map(oldLines.map((line) => [line.employeeId, line.incomeTax.toString()]));
      await this.computeRun(tx, tenantId, companyId, id, run.period, taxes);
    }, POSTING_TX_OPTIONS);
    return this.getRun(id.toString());
  }

  private async computeRun(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    companyId: bigint,
    runId: bigint,
    period: string,
    oldTaxes: Map<bigint, string>,
  ) {
    const { start, end } = periodBounds(period);
    const settings = await tx.payrollSettings.findFirst({
      where: { effectiveFrom: { lte: end } },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    if (!settings) throw new DomainError(ErrorCode.PAYROLL_SETTINGS_REQUIRED, 'No payroll settings for period');

    const employees = await tx.employee.findMany({
      where: { isActive: true },
      include: {
        salaries: { where: { effectiveFrom: { lte: end } }, orderBy: [{ effectiveFrom: 'desc' }], take: 1 },
        recurringElements: {
          where: { validFrom: { lte: end }, OR: [{ validTo: null }, { validTo: { gte: start } }] },
          include: { payElement: true },
        },
        payrollInputs: { where: { period }, include: { payElement: true } },
      },
      orderBy: [{ id: 'asc' }],
    });
    await tx.payrollLine.deleteMany({ where: { payrollRunId: runId } });
    const totals = {
      basic: new Decimal(0),
      earnings: new Decimal(0),
      gross: new Decimal(0),
      sscBase: new Decimal(0),
      sscEmployee: new Decimal(0),
      sscEmployer: new Decimal(0),
      incomeTax: new Decimal(0),
      deductions: new Decimal(0),
      net: new Decimal(0),
    };
    for (const employee of employees) {
      const salary = employee.salaries[0];
      if (!salary) continue;
      const toElement = (element: (typeof employee.payrollInputs)[number]['payElement']): PayrollElement =>
        ({ ...element, rateFactor: element.rateFactor.toString() }) as PayrollElement;
      const inputs: PayrollElementEntry[] = employee.payrollInputs.map((input) => ({
        element: toElement(input.payElement),
        amount: input.amount?.toString() ?? null,
        quantity: input.quantity?.toString() ?? null,
      }));
      const recurring: PayrollRecurringEntry[] = employee.recurringElements.map((item) => ({
        element: toElement(item.payElement),
        amount: item.amount?.toString() ?? null,
        quantity: item.quantity?.toString() ?? null,
        validFrom: item.validFrom,
        validTo: item.validTo,
      }));
      const calculation = calculatePayroll({
        employee,
        salary: salary.basicSalary.toString(),
        periodStart: start,
        periodEnd: end,
        settings: {
          employeeRate: settings.sscEmployeeRate.toString(),
          employerRate: settings.sscEmployerRate.toString(),
          hazardousExtra: settings.sscHazardousExtra.toString(),
          minimumWage: settings.sscMinWage.toString(),
          maximumWage: settings.sscMaxWage?.toString() ?? null,
          hoursPerMonth: settings.hoursPerMonth.toString(),
          daysPerMonth: settings.daysPerMonth.toString(),
        },
        inputs,
        recurring,
        incomeTax: oldTaxes.get(employee.id) ?? '0',
      });
      if (!calculation) continue;
      const line = await tx.payrollLine.create({
        data: {
          tenantId,
          payrollRunId: runId,
          employeeId: employee.id,
          basic: calculation.basic,
          earnings: calculation.earnings,
          gross: calculation.gross,
          sscBase: calculation.sscBase,
          sscEmployee: calculation.sscEmployee,
          sscEmployer: calculation.sscEmployer,
          incomeTax: calculation.incomeTax,
          deductions: calculation.deductions,
          net: calculation.net,
        },
      });
      if (calculation.items.length) {
        await tx.payrollLineItem.createMany({
          data: calculation.items.map((item) => ({
            tenantId,
            payrollLineId: line.id,
            payElementId: item.element.id,
            kind: item.element.kind,
            description: item.element.nameEn ?? item.element.nameAr,
            quantity: item.quantity,
            rate: item.rate,
            amount: item.amount,
          })),
        });
      }
      totals.basic = totals.basic.plus(calculation.basic);
      totals.earnings = totals.earnings.plus(calculation.earnings);
      totals.gross = totals.gross.plus(calculation.gross);
      totals.sscBase = totals.sscBase.plus(calculation.sscBase);
      totals.sscEmployee = totals.sscEmployee.plus(calculation.sscEmployee);
      totals.sscEmployer = totals.sscEmployer.plus(calculation.sscEmployer);
      totals.incomeTax = totals.incomeTax.plus(calculation.incomeTax);
      totals.deductions = totals.deductions.plus(calculation.deductions);
      totals.net = totals.net.plus(calculation.net);
    }
    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        basicTotal: round3(totals.basic),
        earningsTotal: round3(totals.earnings),
        grossTotal: round3(totals.gross),
        sscBaseTotal: round3(totals.sscBase),
        sscEmployeeTotal: round3(totals.sscEmployee),
        sscEmployerTotal: round3(totals.sscEmployer),
        incomeTaxTotal: round3(totals.incomeTax),
        deductionsTotal: round3(totals.deductions),
        netTotal: round3(totals.net),
      },
    });
  }

  async setIncomeTax(runId: bigint, lineId: bigint, amount: string) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${runId} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      const line = await tx.payrollLine.findFirst({ where: { id: lineId, payrollRunId: runId } });
      if (!run || !line) throw DomainError.notFound('PayrollLine', lineId.toString());
      if (run.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Tax can only be edited on a draft');
      const incomeTax = round3(amount);
      const net = round3(line.gross.minus(line.sscEmployee).minus(incomeTax).minus(line.deductions));
      await tx.payrollLine.update({ where: { id: lineId }, data: { incomeTax, net } });
      await tx.payrollRun.update({
        where: { id: runId },
        data: {
          incomeTaxTotal: round3(run.incomeTaxTotal.minus(line.incomeTax).plus(incomeTax)),
          netTotal: round3(run.netTotal.minus(line.net).plus(net)),
        },
      });
      return { id: lineId.toString(), incomeTax: incomeTax.toString(), net: net.toString() };
    }, POSTING_TX_OPTIONS);
  }

  async postRun(id: bigint) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({
        where: { id },
        include: {
          lines: {
            include: {
              employee: { select: { branchId: true, costCenterId: true } },
              items: { include: { payElement: { select: { accountId: true } } } },
            },
          },
        },
      });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft runs can be posted');
      if (run.lines.some((line) => line.net.lt(0))) throw new DomainError(ErrorCode.PAYROLL_NEGATIVE_NET, 'Payroll net cannot be negative');
      const mappings = await tx.accountMapping.findMany({ where: { mappingKey: { in: [...MAPPING_KEYS] } } });
      const map = new Map(mappings.map((row) => [row.mappingKey, row.accountId]));
      const accountId = (key: (typeof MAPPING_KEYS)[number]) => {
        const idForMapping = map.get(key);
        if (!idForMapping) throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, `Missing mapping ${key}`);
        return idForMapping;
      };
      const grouped = new Map<string, { accountId: bigint; branchId: bigint | null; costCenterId: bigint | null; debit: Decimal; credit: Decimal; description: string }>();
      const add = (
        glAccount: bigint,
        amount: Decimal,
        side: 'debit' | 'credit',
        branchId: bigint | null,
        costCenterId: bigint | null,
        description: string,
      ) => {
        if (!amount.gt(0)) return;
        const key = `${glAccount}:${branchId ?? ''}:${costCenterId ?? ''}`;
        const entry = grouped.get(key) ?? {
          accountId: glAccount, branchId, costCenterId, debit: new Decimal(0), credit: new Decimal(0), description,
        };
        entry[side] = entry[side].plus(amount);
        grouped.set(key, entry);
      };
      for (const line of run.lines) {
        add(accountId('PAYROLL_SALARIES_EXPENSE'), line.basic, 'debit', line.employee.branchId, line.employee.costCenterId, 'Basic salaries');
        add(accountId('PAYROLL_SSC_EXPENSE'), line.sscEmployer, 'debit', line.employee.branchId, line.employee.costCenterId, 'Employer social security');
        for (const item of line.items) {
          if (!item.payElement?.accountId) throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'Payroll item has no account');
          add(
            item.payElement.accountId,
            item.amount,
            item.kind === 'EARNING' ? 'debit' : 'credit',
            line.employee.branchId,
            line.employee.costCenterId,
            item.description,
          );
        }
      }
      add(accountId('PAYROLL_SSC_PAYABLE'), run.sscEmployeeTotal.plus(run.sscEmployerTotal), 'credit', null, null, 'Social security payable');
      add(accountId('PAYROLL_TAX_PAYABLE'), run.incomeTaxTotal, 'credit', null, null, 'Income tax withheld');
      add(accountId('PAYROLL_PAYABLE'), run.netTotal, 'credit', null, null, 'Net salaries payable');
      const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, run.runDate);
      const runNo = await allocateDocumentNo(tx, tenantId, companyId, 'PAYROLL_RUN', run.runDate);
      const entry = await this.posting.postEntry(tx, {
        tenantId,
        companyId,
        entryDate: run.runDate,
        fiscalPeriodId: period.id,
        sourceType: 'PAYROLL_RUN',
        sourceId: run.id,
        description: `Payroll ${run.period}`,
        lines: [...grouped.values()].map((line): JournalLineInput => ({
          accountId: line.accountId,
          debit: line.debit,
          credit: line.credit,
          branchId: line.branchId,
          costCenterId: line.costCenterId,
          description: line.description,
        })),
        requireCostCenters: true,
      });
      await tx.payrollRun.update({
        where: { id },
        data: { status: 'POSTED', runNo, journalEntryId: entry.id },
      });
    }, POSTING_TX_OPTIONS);
    return this.getRun(id.toString());
  }

  async payRun(id: bigint, dto: PayrollPaymentDto) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    if (!!dto.cashBoxId === !!dto.bankAccountId) {
      throw new DomainError(ErrorCode.VALIDATION, 'Choose exactly one cash box or bank account');
    }
    const payDate = date(dto.date);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'POSTED') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted runs can be paid');
      if (!run.netTotal.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'Payroll net must be positive to pay');
      const account = dto.cashBoxId
        ? await tx.cashBox.findFirst({ where: { id: BigInt(dto.cashBoxId), isActive: true } })
        : await tx.bankAccount.findFirst({ where: { id: BigInt(dto.bankAccountId!), isActive: true } });
      if (!account) throw DomainError.notFound('CashBox/BankAccount', dto.cashBoxId ?? dto.bankAccountId!);
      const payable = await tx.accountMapping.findFirst({ where: { mappingKey: 'PAYROLL_PAYABLE' } });
      if (!payable) throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, 'Missing payroll payable mapping');
      const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, payDate);
      const entry = await this.posting.postEntry(tx, {
        tenantId,
        companyId,
        entryDate: payDate,
        fiscalPeriodId: period.id,
        sourceType: 'PAYROLL_PAYMENT',
        sourceId: run.id,
        description: `Payroll payment ${run.period}`,
        lines: [
          { accountId: payable.accountId, debit: run.netTotal },
          { accountId: account.accountId, credit: run.netTotal },
        ],
      });
      await tx.payrollRun.update({
        where: { id },
        data: {
          status: 'PAID',
          paymentEntryId: entry.id,
          paidFromCashBoxId: dto.cashBoxId ? BigInt(dto.cashBoxId) : null,
          paidFromBankAccountId: dto.bankAccountId ? BigInt(dto.bankAccountId) : null,
        },
      });
    }, POSTING_TX_OPTIONS);
    return this.getRun(id.toString());
  }

  async reverseRun(id: bigint, reversalDate: Date) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'POSTED' && run.status !== 'PAID') {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted or paid runs can be reversed');
      }
      if (run.status === 'PAID' && run.paymentEntryId) {
        await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: run.paymentEntryId, reversalDate });
      }
      if (run.journalEntryId) {
        await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: run.journalEntryId, reversalDate });
      }
      await tx.payrollRun.update({ where: { id }, data: { status: 'REVERSED' } });
    }, POSTING_TX_OPTIONS);
    return this.getRun(id.toString());
  }

  async listRuns() {
    const { db } = this.context();
    const runs = await db.payrollRun.findMany({ orderBy: [{ period: 'desc' }, { id: 'desc' }] });
    return runs.map((run) => this.runDto(run));
  }

  async getRun(idOrPeriod: string, byPeriod = false) {
    const { db } = this.context();
    const run = await db.payrollRun.findFirst({
      where: byPeriod ? { period: idOrPeriod } : { id: BigInt(idOrPeriod) },
      include: {
        lines: {
          include: {
            employee: { select: { nameAr: true } },
            items: { select: { description: true, kind: true, amount: true, quantity: true, rate: true } },
          },
          orderBy: [{ employeeId: 'asc' }],
        },
      },
      orderBy: [{ id: 'desc' }],
    });
    if (!run) throw DomainError.notFound('PayrollRun', idOrPeriod);
    return {
      ...this.runDto(run),
      lines: run.lines.map((line) => ({
        id: line.id.toString(),
        employeeId: line.employeeId.toString(),
        employeeName: line.employee.nameAr,
        basic: line.basic.toString(),
        earnings: line.earnings.toString(),
        gross: line.gross.toString(),
        sscBase: line.sscBase.toString(),
        sscEmployee: line.sscEmployee.toString(),
        sscEmployer: line.sscEmployer.toString(),
        incomeTax: line.incomeTax.toString(),
        deductions: line.deductions.toString(),
        net: line.net.toString(),
        items: line.items.map((item) => ({
          description: item.description,
          kind: item.kind,
          amount: item.amount.toString(),
          quantity: item.quantity?.toString() ?? null,
          rate: item.rate?.toString() ?? null,
        })),
      })),
    };
  }

  private runDto(run: {
    id: bigint; period: string; status: string; runNo: string | null; basicTotal: Decimal; earningsTotal: Decimal;
    grossTotal: Decimal; sscBaseTotal: Decimal; sscEmployeeTotal: Decimal; sscEmployerTotal: Decimal;
    incomeTaxTotal: Decimal; deductionsTotal: Decimal; netTotal: Decimal;
  }) {
    return {
      id: run.id.toString(),
      period: run.period,
      status: run.status,
      runNo: run.runNo,
      basicTotal: run.basicTotal.toString(),
      earningsTotal: run.earningsTotal.toString(),
      grossTotal: run.grossTotal.toString(),
      sscBaseTotal: run.sscBaseTotal.toString(),
      sscEmployeeTotal: run.sscEmployeeTotal.toString(),
      sscEmployerTotal: run.sscEmployerTotal.toString(),
      incomeTaxTotal: run.incomeTaxTotal.toString(),
      deductionsTotal: run.deductionsTotal.toString(),
      netTotal: run.netTotal.toString(),
    };
  }
}
