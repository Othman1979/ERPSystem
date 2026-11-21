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
import { DEFAULT_PAYROLL_TAX_BRACKETS } from '../accounting/chart-template.js';
import { PostingService, type JournalLineInput } from '../journal/posting.service.js';
import { YearClosingDraftRegistry, yearClosingDraft } from '../accounting/year-closing-draft.registry.js';
import { CostCenterUsageRegistry } from '../cost-centers/cost-center-usage.registry.js';
import { isIncomeStatement } from '../cost-centers/cost-center-rules.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import {
  calculateMovementPrice,
  calculatePayroll,
  latestEffectiveOnDate,
  type PayrollElement,
  type PayrollElementEntry,
  type PayrollRecurringEntry,
} from './payroll-calculator.js';
import {
  annualLeaveEntitlement,
  carryIntoYear,
  countLeaveDays,
  leavePeriodQuantity,
  leaveProvision as calculateLeaveProvision,
} from './leave-calculator.js';
import {
  calculateEos,
  calculateLeaveEncashment,
  calculateServiceYears,
} from './settlement-calculator.js';
import type {
  CreateEmployeeDto,
  CreatePayElementDto,
  CreatePayrollMovementDto,
  CreatePayrollSettingsDto,
  CreateRecurringElementDto,
  CreateSalaryDto,
  PayrollPaymentDto,
  UpdateEmployeeDto,
  UpdatePayElementDto,
} from './dto/payroll.dto.js';

const MAPPING_KEYS = [
  'PAYROLL_SALARIES_EXPENSE',
  'PAYROLL_SSC_EXPENSE',
  'PAYROLL_PAYABLE',
  'PAYROLL_SSC_PAYABLE',
  'PAYROLL_TAX_PAYABLE',
  'PAYROLL_LEAVE_PROVISION',
  'PAYROLL_LEAVE_EXPENSE',
  'PAYROLL_EOS_PROVISION',
  'PAYROLL_EOS_EXPENSE',
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
    yearClosingDrafts.register('PAYROLL_SETTLEMENT', async (tx, tenantId, companyId, from, to) => {
      const settlements = await tx.payrollSettlement.findMany({
        where: { tenantId, companyId, status: 'DRAFT', settlementDate: { gte: from, lte: to } },
        select: { id: true, settlementDate: true, settlementNo: true },
      });
      return settlements.map((settlement) =>
        yearClosingDraft('PAYROLL_SETTLEMENT', settlement.id, settlement.settlementDate, settlement.settlementNo, 'Payroll settlement'));
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

  private async ensureMovementPeriodAllowed(tx: Prisma.TransactionClient, period: string) {
    const run = await tx.payrollRun.findFirst({
      where: { period, status: { in: ['POSTED', 'PAID'] } },
      select: { id: true },
    });
    if (run) throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Payroll movements are locked after posting');
  }

  async listEmployees() {
    const { db } = this.context();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const employees = await db.employee.findMany({
      orderBy: [{ code: 'asc' }],
      include: {
        branch: { select: { nameAr: true, nameEn: true } },
        salaries: { where: { effectiveFrom: { lte: today } }, orderBy: [{ effectiveFrom: 'desc' }], take: 1 },
      },
    });
    return employees.map(({ branch, salaries, taxOtherExemption, ...employee }) => ({
      ...employee,
      taxOtherExemption: taxOtherExemption.toString(),
      branchNameAr: branch?.nameAr ?? null,
      branchNameEn: branch?.nameEn ?? null,
      currentBasicSalary: salaries[0]?.basicSalary.toString() ?? null,
    }));
  }

  getEmployee(id: bigint) {
    const { db } = this.context();
    return db.employee.findFirst({
      where: { id },
      include: {
        salaries: { orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }] },
        recurringElements: {
          include: { payElement: true },
          orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
        },
      },
    }).then((employee) => {
      if (!employee) throw DomainError.notFound('Employee', id.toString());
      return { ...employee, taxOtherExemption: employee.taxOtherExemption.toString() };
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
        taxSubject: dto.taxSubject ?? true,
        taxDependants: dto.taxDependants ?? false,
        taxOtherExemption: dto.taxOtherExemption ?? '0.000',
      },
    });
  }

  async updateEmployee(id: bigint, dto: UpdateEmployeeDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const employee = await tx.employee.findFirst({
        where: { id },
        select: { id: true, isActive: true, hireDate: true, leaveDate: true, sscCovered: true },
      });
      if (!employee) throw DomainError.notFound('Employee', id.toString());
      const sensitiveChange =
        (dto.hireDate !== undefined && date(dto.hireDate).getTime() !== employee.hireDate.getTime())
        || (dto.leaveDate !== undefined && (
          dto.leaveDate === null
            ? employee.leaveDate !== null
            : employee.leaveDate === null || date(dto.leaveDate).getTime() !== employee.leaveDate.getTime()
        ))
        || (dto.sscCovered !== undefined && dto.sscCovered !== employee.sscCovered);
      if (sensitiveChange) {
        const settlement = await tx.payrollSettlement.findFirst({
          where: { companyId, employeeId: id, status: { in: ['DRAFT', 'POSTED', 'PAID'] } },
          select: { id: true },
        });
        if (settlement) throw new DomainError(ErrorCode.PAYROLL_SETTLEMENT_ACTIVE, 'Employee has an active final settlement');
        const departurePeriods = [...new Set(
          [employee.leaveDate, dto.leaveDate ? date(dto.leaveDate) : null]
            .filter((leaveDate): leaveDate is Date => leaveDate !== null)
            .map((leaveDate) => `${leaveDate.getUTCFullYear()}-${String(leaveDate.getUTCMonth() + 1).padStart(2, '0')}`),
        )];
        if (departurePeriods.length) {
          const departureRun = await tx.payrollRun.findFirst({
            where: {
              companyId,
              period: { in: departurePeriods },
              status: { in: ['POSTED', 'PAID'] },
              lines: { some: { employeeId: id } },
            },
            select: { id: true },
          });
          if (departureRun) {
            throw new DomainError(ErrorCode.PAYROLL_SETTLEMENT_ACTIVE, 'Employee has a posted departure payroll run');
          }
        }
      }
      if (employee.isActive && dto.isActive === false) {
        const movements = await tx.payrollMovement.findMany({
          where: { companyId, employeeId: id, status: 'POSTED' },
          select: { period: true },
        });
        const periods = [...new Set(movements.map((movement) => movement.period))];
        if (periods.length) {
          const completedRuns = await tx.payrollRun.findMany({
            where: { companyId, period: { in: periods }, status: { in: ['POSTED', 'PAID'] } },
            select: { period: true },
          });
          const completedPeriods = new Set(completedRuns.map((run) => run.period));
          if (movements.some((movement) => !completedPeriods.has(movement.period))) {
            throw new DomainError(ErrorCode.VALIDATION, 'Employee cannot be deactivated while posted payroll movements await a run');
          }
        }
      }
      if (dto.code !== undefined) {
        const duplicate = await tx.employee.findFirst({ where: { code: dto.code, id: { not: id } }, select: { id: true } });
        if (duplicate) throw new DomainError(ErrorCode.DUPLICATE_CODE, 'Employee code already exists');
      }
      await tx.employee.update({
        where: { id },
        data: {
          code: dto.code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn === undefined ? undefined : dto.nameEn ?? null,
          nationalId: dto.nationalId === undefined ? undefined : dto.nationalId ?? null,
          sscNumber: dto.sscNumber === undefined ? undefined : dto.sscNumber ?? null,
          hireDate: dto.hireDate === undefined ? undefined : date(dto.hireDate),
          leaveDate: dto.leaveDate === undefined ? undefined : dto.leaveDate ? date(dto.leaveDate) : null,
          branchId: dto.branchId === undefined ? undefined : dto.branchId ? BigInt(dto.branchId) : null,
          costCenterId: dto.costCenterId === undefined ? undefined : dto.costCenterId ? BigInt(dto.costCenterId) : null,
          payMethod: dto.payMethod,
          iban: dto.iban === undefined ? undefined : dto.iban ?? null,
          sscCovered: dto.sscCovered,
          sscHazardous: dto.sscHazardous,
          taxSubject: dto.taxSubject,
          taxDependants: dto.taxDependants,
          taxOtherExemption: dto.taxOtherExemption,
          isActive: dto.isActive,
        },
      });
    }, POSTING_TX_OPTIONS);
    return this.getEmployee(id);
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
      include: { payElement: { select: { id: true, code: true, nameAr: true, amountType: true, kind: true, isFixedAllowance: true } } },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    });
  }

  async createRecurring(employeeId: bigint, dto: CreateRecurringElementDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const employee = await tx.employee.findFirst({ where: { id: employeeId }, select: { id: true } });
      if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
      const element = await tx.payElement.findFirst({ where: { id: BigInt(dto.payElementId), isActive: true } });
      if (!element) throw DomainError.notFound('PayElement', dto.payElementId);
      if (!element.isFixedAllowance) {
        throw new DomainError(ErrorCode.VALIDATION, 'Only fixed allowances can recur on the employee card');
      }
      if (dto.amount == null || new Decimal(dto.amount).lt('0') || dto.quantity !== undefined) {
        throw new DomainError(ErrorCode.VALIDATION, 'Recurring amount must be non-negative and quantity must be absent');
      }
      const validFrom = date(dto.validFrom);
      const validTo = dto.validTo ? date(dto.validTo) : null;
      if (validTo && validTo < validFrom) throw new DomainError(ErrorCode.VALIDATION, 'validTo must not precede validFrom');
      return tx.employeeRecurringElement.create({
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
    }, POSTING_TX_OPTIONS);
  }

  async deleteRecurring(employeeId: bigint, recurringId: bigint) {
    this.canManage();
    const { db } = this.context();
    const employee = await db.employee.findFirst({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
    const recurring = await db.employeeRecurringElement.findFirst({
      where: { id: recurringId, employeeId },
      select: { id: true },
    });
    if (!recurring) throw DomainError.notFound('EmployeeRecurringElement', recurringId.toString());
    await db.employeeRecurringElement.delete({ where: { id: recurringId } });
    return { id: recurringId.toString(), deleted: true };
  }

  listElements() {
    const { db } = this.context();
    return db.payElement.findMany({ orderBy: [{ code: 'asc' }] });
  }

  async createElement(dto: CreatePayElementDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    if (dto.isFixedAllowance === true && (dto.kind !== 'EARNING' || dto.amountType !== 'FIXED')) {
      throw new DomainError(ErrorCode.VALIDATION, 'Only fixed earning elements can be flagged as allowances');
    }
    const accountId = BigInt(dto.accountId);
    const account = await db.account.findFirst({ where: { id: accountId } });
    const payable = await db.accountMapping.findFirst({
      where: { tenantId, companyId, mappingKey: 'PAYROLL_PAYABLE' },
      select: { accountId: true },
    });
    const validType =
      dto.kind === 'EARNING'
        ? account?.accountType === 'EXPENSE'
        : account?.accountType === 'ASSET' || account?.accountType === 'LIABILITY' ||
          account?.accountType === 'REVENUE' || account?.accountType === 'EXPENSE';
    if (
      !account ||
      !validType ||
      account.isControl ||
      account.controlType !== null ||
      !account.isPostable ||
      !account.isActive ||
      payable?.accountId === accountId
    ) {
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
        taxSubject: dto.taxSubject ?? true,
        isFixedAllowance: dto.isFixedAllowance ?? false,
        accountId,
      },
    });
  }

  async updateElement(id: bigint, dto: UpdatePayElementDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const element = await tx.payElement.findFirst({ where: { id } });
      if (!element) throw DomainError.notFound('PayElement', id.toString());
      if (
        element.code === 'LEAVE_ENCASHMENT'
        && (
          dto.isActive === false
          || (dto.kind !== undefined && dto.kind !== element.kind)
          || (dto.amountType !== undefined && dto.amountType !== element.amountType)
        )
      ) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'The leave-encashment system element cannot be changed');
      }
      const typeChanged =
        (dto.kind !== undefined && dto.kind !== element.kind) ||
        (dto.amountType !== undefined && dto.amountType !== element.amountType);
      const unsettingFixedAllowance = dto.isFixedAllowance === false && element.isFixedAllowance;
      const removingFromUse = dto.isActive === false && element.isActive;
      const leaveTypeReference = typeChanged || removingFromUse
        ? await tx.leaveType.findFirst({ where: { payElementId: id }, select: { id: true } })
        : null;
      if (leaveTypeReference) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Pay element is referenced by a leave type');
      }
      const kind = dto.kind ?? element.kind;
      const amountType = dto.amountType ?? element.amountType;
      const recurring = typeChanged || unsettingFixedAllowance
        ? await tx.employeeRecurringElement.findFirst({
          where: { tenantId, payElementId: id },
          select: { id: true },
        })
        : null;
      if (typeChanged) {
        const movement = await tx.payrollMovement.findFirst({ where: { payElementId: id }, select: { id: true } });
        const lineItem = await tx.payrollLineItem.findFirst({ where: { payElementId: id }, select: { id: true } });
        if (movement || recurring || lineItem) {
          throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Used pay element type cannot be changed');
        }
      }
      const isFixedAllowance = dto.isFixedAllowance ?? element.isFixedAllowance;
      if (isFixedAllowance && (kind !== 'EARNING' || amountType !== 'FIXED')) {
        throw new DomainError(ErrorCode.VALIDATION, 'Only fixed earning elements can be flagged as allowances');
      }
      if (unsettingFixedAllowance && recurring) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Fixed allowance cannot be unset while recurring rows reference it');
      }
      if (dto.accountId === null) throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'Pay element account is not allowed');
      const accountId = dto.accountId === undefined ? element.accountId : BigInt(dto.accountId);
      const account = await tx.account.findFirst({ where: { id: accountId } });
      const payable = await tx.accountMapping.findFirst({
        where: { tenantId, companyId, mappingKey: 'PAYROLL_PAYABLE' },
        select: { accountId: true },
      });
      const validType =
        kind === 'EARNING'
          ? account?.accountType === 'EXPENSE'
          : account?.accountType === 'ASSET' || account?.accountType === 'LIABILITY' ||
            account?.accountType === 'REVENUE' || account?.accountType === 'EXPENSE';
      if (
        !account ||
        !validType ||
        account.isControl ||
        account.controlType !== null ||
        !account.isPostable ||
        !account.isActive ||
        payable?.accountId === accountId
      ) {
        throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'Pay element account is not allowed');
      }
      return tx.payElement.update({
        where: { id },
        data: {
          nameAr: dto.nameAr,
          nameEn: dto.nameEn === undefined ? undefined : dto.nameEn ?? null,
          kind: dto.kind,
          amountType: dto.amountType,
          rateFactor: dto.rateFactor,
          sscSubject: dto.sscSubject,
          taxSubject: dto.taxSubject,
          isFixedAllowance: dto.isFixedAllowance,
          accountId: dto.accountId === undefined ? undefined : accountId,
          isActive: dto.isActive,
        },
      });
    }, POSTING_TX_OPTIONS);
  }

  listSettings() {
    const { db } = this.context();
    return db.payrollSettings.findMany({
      include: { taxBrackets: { orderBy: [{ seq: 'asc' }] } },
      orderBy: [{ effectiveFrom: 'desc' }],
    }).then((rows) => rows.map((row) => ({
      ...row,
      weeklyRestDays: row.weeklyRestDays.split(',').map(Number),
    })));
  }

  async createSettings(dto: CreatePayrollSettingsDto) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    const zero = new Decimal('0');
    const one = new Decimal('1');
    const rates = [dto.sscEmployeeRate ?? '0.075000', dto.sscEmployerRate ?? '0.142500', dto.sscHazardousExtra ?? '0.010000'].map((value) => new Decimal(value));
    const minimum = new Decimal(dto.sscMinWage ?? '290.000');
    const maximum = dto.sscMaxWage == null ? null : new Decimal(dto.sscMaxWage);
    const taxPersonalExemption = new Decimal(dto.taxPersonalExemption ?? '9000.000');
    const taxDependantsExemption = new Decimal(dto.taxDependantsExemption ?? '9000.000');
    const taxNationalThreshold = new Decimal(dto.taxNationalThreshold ?? '16666.000');
    const taxNationalRate = new Decimal(dto.taxNationalRate ?? '0.010000');
    const eosTaxExemption = new Decimal(dto.eosTaxExemption ?? '15000.000');
    const eosTaxRate = new Decimal(dto.eosTaxRate ?? '0.090000');
    const eosNationalThreshold = new Decimal(dto.eosNationalThreshold ?? '200000.000');
    const eosNationalRate = new Decimal(dto.eosNationalRate ?? '0.010000');
    const annualLeaveDays = new Decimal(dto.annualLeaveDays ?? '14.00');
    const annualLeaveDaysSenior = new Decimal(dto.annualLeaveDaysSenior ?? '21.00');
    const annualLeaveSeniorYears = dto.annualLeaveSeniorYears ?? 5;
    const restDays = dto.weeklyRestDays ?? [5];
    const taxBrackets = dto.taxBrackets ?? DEFAULT_PAYROLL_TAX_BRACKETS.map(({ upTo, rate }) => ({ upTo, rate }));
    let previousUpTo: Decimal | null = null;
    let unbounded = false;
    const validTaxBrackets = taxBrackets.length > 0 && taxBrackets.every((bracket, index) => {
      const rate = new Decimal(bracket.rate);
      if (rate.lt(zero) || rate.gt(one) || bracket.upTo === undefined || unbounded) return false;
      if (bracket.upTo === null) {
        unbounded = true;
        return index === taxBrackets.length - 1;
      }
      const upTo = new Decimal(bracket.upTo);
      if (upTo.lt(zero) || (previousUpTo !== null && !upTo.gt(previousUpTo))) return false;
      previousUpTo = upTo;
      return true;
    });
    if (
      rates.some((rate) => rate.lt(zero) || rate.gt(one)) ||
      !new Decimal(dto.hoursPerMonth ?? '240').gt(zero) ||
      !new Decimal(dto.daysPerMonth ?? '30').gt(zero) ||
      minimum.lt(zero) ||
      (maximum !== null && (maximum.lt(zero) || maximum.lt(minimum))) ||
      taxPersonalExemption.lt(zero) || taxDependantsExemption.lt(zero) || taxNationalThreshold.lt(zero) ||
      taxNationalRate.lt(zero) || taxNationalRate.gt(one) || !validTaxBrackets
      || eosTaxExemption.lt(zero) || eosTaxRate.lt(zero) || eosTaxRate.gt(one)
      || eosNationalThreshold.lt(zero) || eosNationalRate.lt(zero) || eosNationalRate.gt(one)
      || annualLeaveDays.lt(zero) || annualLeaveDaysSenior.lt(zero)
      || !Number.isInteger(annualLeaveSeniorYears) || annualLeaveSeniorYears < 0
      || restDays.length < 1 || restDays.length > 6 || new Set(restDays).size !== restDays.length
      || restDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    ) {
      throw new DomainError(ErrorCode.VALIDATION, 'Payroll rates, wages, hours, or days are outside the allowed range');
    }
    return db.$transaction(async (tx) => {
      const settings = await tx.payrollSettings.create({
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
          weeklyRestDays: restDays.join(','),
          annualLeaveDays,
          annualLeaveDaysSenior,
          annualLeaveSeniorYears,
          taxPersonalExemption,
          taxDependantsExemption,
          taxNationalThreshold,
          taxNationalRate,
          eosTaxExemption,
          eosTaxRate,
          eosNationalThreshold,
          eosNationalRate,
        },
      });
      await tx.payrollTaxBracket.createMany({
        data: taxBrackets.map((bracket, index) => ({
          tenantId,
          payrollSettingsId: settings.id,
          seq: index + 1,
          upTo: bracket.upTo,
          rate: bracket.rate,
        })),
      });
      return {
        ...settings,
        weeklyRestDays: restDays,
        taxBrackets: await tx.payrollTaxBracket.findMany({
          where: { payrollSettingsId: settings.id },
          orderBy: [{ seq: 'asc' }],
        }),
      };
    }, POSTING_TX_OPTIONS);
  }

  async listMovements(period: string, employeeId?: string) {
    periodBounds(period);
    const { db } = this.context();
    const movements = await db.payrollMovement.findMany({
      where: { period, ...(employeeId ? { employeeId: BigInt(employeeId) } : {}) },
      include: {
        employee: { select: { nameAr: true } },
        payElement: { select: { code: true, nameAr: true } },
      },
      orderBy: [{ movementDate: 'asc' }, { employeeId: 'asc' }, { id: 'asc' }],
    });
    return movements.map((movement) => this.movementDto(movement));
  }

  async createMovement(dto: CreatePayrollMovementDto) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    const movementDate = date(dto.movementDate);
    const period = dto.movementDate.slice(0, 7);
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    const movementId = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await this.ensureMovementPeriodAllowed(tx, period);
      const employee = await tx.employee.findFirst({ where: { id: BigInt(dto.employeeId) } });
      if (!employee) throw DomainError.notFound('Employee', dto.employeeId);
      if (!employee.isActive) throw new DomainError(ErrorCode.VALIDATION, 'Employee is inactive');
      const element = await tx.payElement.findFirst({
        where: { id: BigInt(dto.payElementId) },
        include: { account: { select: { accountType: true } } },
      });
      if (!element) throw DomainError.notFound('PayElement', dto.payElementId);
      if (!element.isActive) throw new DomainError(ErrorCode.VALIDATION, 'Pay element is inactive');
      const fixed = element.amountType === 'FIXED';
      const value = fixed ? dto.amount : dto.quantity;
      if (value == null || !new Decimal(value).gt(0) || (fixed ? dto.quantity != null : dto.amount != null)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Movement values must match its pay element amount type and be positive');
      }
      const salaryRows = await tx.employeeSalary.findMany({
        where: { employeeId: employee.id, effectiveFrom: { lte: movementDate } },
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      });
      const salary = latestEffectiveOnDate(salaryRows, movementDate);
      if (!salary) throw new DomainError(ErrorCode.VALIDATION, 'No salary in force');
      const settingsRows = await tx.payrollSettings.findMany({
        where: { effectiveFrom: { lte: movementDate } },
        orderBy: [{ effectiveFrom: 'desc' }],
      });
      const settings = latestEffectiveOnDate(settingsRows, movementDate);
      if (!settings) throw new DomainError(ErrorCode.PAYROLL_SETTINGS_REQUIRED, 'No payroll settings in force');
      const price = calculateMovementPrice({
        amountType: element.amountType,
        amount: dto.amount ?? null,
        quantity: dto.quantity ?? null,
        salary: salary.basicSalary,
        rateFactor: element.rateFactor,
        hoursPerMonth: settings.hoursPerMonth,
        daysPerMonth: settings.daysPerMonth,
      });
      if (!price.amount.gt(0)) throw new DomainError(ErrorCode.VALIDATION, 'Movement amount must be positive');
      const payable = await tx.accountMapping.findFirst({ where: { mappingKey: 'PAYROLL_PAYABLE' } });
      if (!payable) throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, 'Missing payroll payable mapping');
      const periodRow = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, movementDate);
      const movementNo = await allocateDocumentNo(tx, tenantId, companyId, 'PAYROLL_MOVEMENT', movementDate);
      const movement = await tx.payrollMovement.create({
        data: {
          tenantId,
          companyId,
          employeeId: employee.id,
          payElementId: element.id,
          movementNo,
          movementDate,
          period,
          quantity: price.quantity,
          rate: price.rate,
          amount: price.amount,
          description: dto.description,
          status: 'POSTED',
          postedBy: userId,
        },
      });
      const elementCostCenterId = isIncomeStatement(element.account.accountType) ? employee.costCenterId : null;
      const lines: JournalLineInput[] = element.kind === 'EARNING'
        ? [
            { accountId: element.accountId, debit: price.amount, branchId: employee.branchId, costCenterId: elementCostCenterId, description: dto.description },
            { accountId: payable.accountId, credit: price.amount, branchId: employee.branchId, description: dto.description },
          ]
        : [
            { accountId: payable.accountId, debit: price.amount, branchId: employee.branchId, description: dto.description },
            { accountId: element.accountId, credit: price.amount, branchId: employee.branchId, costCenterId: elementCostCenterId, description: dto.description },
          ];
      const entry = await this.posting.postEntry(tx, {
        tenantId,
        companyId,
        entryDate: movementDate,
        fiscalPeriodId: periodRow.id,
        sourceType: 'PAYROLL_MOVEMENT',
        sourceId: movement.id,
        description: dto.description,
        lines,
        requireCostCenters: true,
        postedBy: userId,
      });
      await tx.payrollMovement.update({ where: { id: movement.id }, data: { journalEntryId: entry.id } });
      await this.audit.log({
        action: 'payroll.movement.post',
        entityType: 'payroll_movement',
        entityId: movement.id,
        after: { movementNo, status: 'POSTED', amount: price.amount.toString() },
      }, tx);
      return movement.id;
    }, POSTING_TX_OPTIONS);
    return this.getMovement(movementId);
  }

  async reverseMovement(id: bigint, reversalDate: Date) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_movements WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const movement = await tx.payrollMovement.findFirst({ where: { id } });
      if (!movement) throw DomainError.notFound('PayrollMovement', id.toString());
      if (movement.status !== 'POSTED' || !movement.journalEntryId) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted payroll movements can be reversed');
      }
      await this.ensureMovementPeriodAllowed(tx, movement.period);
      const reversal = await this.posting.reverseEntry(tx, {
        tenantId,
        companyId,
        entryId: movement.journalEntryId,
        reversalDate,
        postedBy: userId,
      });
      await tx.payrollMovement.update({
        where: { id },
        data: { status: 'REVERSED', reversalEntryId: reversal.id, reversedAt: reversalDate },
      });
      await this.audit.log({
        action: 'payroll.movement.reverse',
        entityType: 'payroll_movement',
        entityId: id,
        after: { status: 'REVERSED', reversalEntryId: reversal.id.toString() },
      }, tx);
    }, POSTING_TX_OPTIONS);
    return this.getMovement(id);
  }

  private async getMovement(id: bigint) {
    const { db } = this.context();
    const movement = await db.payrollMovement.findFirst({
      where: { id },
      include: {
        employee: { select: { nameAr: true } },
        payElement: { select: { code: true, nameAr: true } },
      },
    });
    if (!movement) throw DomainError.notFound('PayrollMovement', id.toString());
    return this.movementDto(movement);
  }

  private movementDto(movement: {
    id: bigint;
    movementNo: string | null;
    employeeId: bigint;
    employee: { nameAr: string };
    payElementId: bigint;
    payElement: { code: string; nameAr: string };
    movementDate: Date;
    period: string;
    quantity: Decimal | null;
    rate: Decimal | null;
    amount: Decimal;
    description: string;
    status: string;
    journalEntryId: bigint | null;
    reversalEntryId: bigint | null;
    reversedAt: Date | null;
  }) {
    return {
      id: movement.id.toString(),
      movementNo: movement.movementNo,
      employeeId: movement.employeeId.toString(),
      employeeName: movement.employee.nameAr,
      payElementId: movement.payElementId.toString(),
      payElementCode: movement.payElement.code,
      payElementName: movement.payElement.nameAr,
      movementDate: movement.movementDate.toISOString().slice(0, 10),
      period: movement.period,
      quantity: movement.quantity?.toString() ?? null,
      rate: movement.rate?.toString() ?? null,
      amount: movement.amount.toString(),
      description: movement.description,
      status: movement.status,
      journalEntryId: movement.journalEntryId?.toString() ?? null,
      reversalEntryId: movement.reversalEntryId?.toString() ?? null,
      reversedAt: movement.reversedAt?.toISOString().slice(0, 10) ?? null,
    };
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
      const lineCount = await tx.payrollLine.count({ where: { payrollRunId: run.id } });
      if (lineCount === 0) throw new DomainError(ErrorCode.PAYROLL_NO_EMPLOYEES, 'No eligible employees for payroll period');
      return run.id;
    }, POSTING_TX_OPTIONS);
    return this.getRun(runId.toString());
  }

  async deleteRun(id: bigint) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'DRAFT') {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft payroll runs can be deleted');
      }
      const lines = await tx.payrollLine.findMany({ where: { payrollRunId: id }, select: { id: true } });
      if (lines.length) {
        await tx.payrollLineItem.deleteMany({ where: { payrollLineId: { in: lines.map((line) => line.id) } } });
      }
      await tx.payrollLine.deleteMany({ where: { payrollRunId: id } });
      await tx.payrollRun.delete({ where: { id } });
      await this.audit.log({ action: 'payroll.run.delete', entityType: 'payroll_run', entityId: id, after: null }, tx);
      return { id: id.toString(), deleted: true };
    }, POSTING_TX_OPTIONS);
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
      const taxes = new Map(oldLines.filter((line) => line.taxManual).map((line) => [line.employeeId, line.incomeTax.toString()]));
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
      include: { taxBrackets: { orderBy: [{ seq: 'asc' }] } },
    });
    if (!settings) throw new DomainError(ErrorCode.PAYROLL_SETTINGS_REQUIRED, 'No payroll settings for period');

    const employees = await tx.employee.findMany({
      where: { isActive: true },
      include: {
        salaries: { where: { effectiveFrom: { lte: end } }, orderBy: [{ effectiveFrom: 'desc' }] },
        recurringElements: {
          where: { validFrom: { lte: end }, OR: [{ validTo: null }, { validTo: { gte: start } }] },
          include: { payElement: true },
        },
        payrollMovements: { where: { period, status: 'POSTED' }, include: { payElement: true } },
        leaveRequests: {
          where: { status: 'APPROVED', startDate: { lte: end }, endDate: { gte: start } },
          include: { leaveType: { include: { payElement: true } } },
        },
      },
      orderBy: [{ id: 'asc' }],
    });
    const holidays = await tx.publicHoliday.findMany({
      where: { date: { gte: start, lte: end } },
      select: { date: true },
    });
    const employeeIds = employees.map((employee) => employee.id);
    const annualLeaveType = await tx.leaveType.findFirst({ where: { category: 'ANNUAL', isActive: true } });
    const [unpaidLeaveRanges, annualRequests, annualAdjustments, leaveSettings, encashmentElement] = employeeIds.length
      ? await Promise.all([
          tx.leaveRequest.findMany({
            where: { employeeId: { in: employeeIds }, status: 'APPROVED', startDate: { lte: end }, leaveType: { category: 'UNPAID' } },
            select: { employeeId: true, startDate: true, endDate: true },
          }),
          annualLeaveType
            ? tx.leaveRequest.findMany({
                where: { employeeId: { in: employeeIds }, leaveTypeId: annualLeaveType.id, status: 'APPROVED', startDate: { lte: end } },
                select: { employeeId: true, startDate: true, endDate: true, days: true },
              })
            : Promise.resolve([]),
          annualLeaveType
            ? tx.leaveBalanceAdjustment.findMany({
                where: { employeeId: { in: employeeIds }, leaveTypeId: annualLeaveType.id, year: { lte: end.getUTCFullYear() } },
                select: { employeeId: true, year: true, days: true },
              })
            : Promise.resolve([]),
          tx.payrollSettings.findMany({ where: { effectiveFrom: { lte: end } }, orderBy: [{ effectiveFrom: 'asc' }] }),
          tx.payElement.findFirst({ where: { code: 'LEAVE_ENCASHMENT' } }),
        ])
      : [[], [], [], [], null] as const;
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
      const salary = latestEffectiveOnDate(employee.salaries, end);
      if (!salary) continue;
      const toElement = (element: (typeof employee.payrollMovements)[number]['payElement']): PayrollElement =>
        ({ ...element, rateFactor: element.rateFactor.toString() }) as PayrollElement;
      const inputs: PayrollElementEntry[] = employee.payrollMovements.map((movement) => ({
        element: toElement(movement.payElement),
        amount: movement.amount.toString(),
        quantity: movement.quantity?.toString() ?? null,
        rate: movement.rate?.toString() ?? null,
        payrollMovementId: movement.id,
      }));
      const leaveInputs: PayrollElementEntry[] = [];
      let remainingLeaveQuantity = new Decimal(settings.daysPerMonth.toString());
      const leaveRequests = [...employee.leaveRequests].sort((a, b) =>
        a.startDate.getTime() - b.startDate.getTime() || a.id.toString().localeCompare(b.id.toString()));
      for (const request of leaveRequests) {
        const element = request.leaveType.payElement;
        if (!element || (request.leaveType.category === 'MATERNITY' && !employee.sscCovered)) continue;
        const requestQuantity = leavePeriodQuantity({
          requestStart: request.startDate,
          requestEnd: request.endDate,
          periodStart: start,
          periodEnd: end,
          countBasis: request.leaveType.countBasis,
          weeklyRestDays: settings.weeklyRestDays.split(',').map(Number),
          holidays: holidays.map((holiday) => holiday.date),
          daysPerMonth: settings.daysPerMonth,
        });
        const quantity = Decimal.min(requestQuantity, remainingLeaveQuantity);
        if (!quantity.gt(0)) continue;
        leaveInputs.push({
          element: toElement(element),
          amount: null,
          quantity,
          leaveRequestId: request.id,
        });
        remainingLeaveQuantity = remainingLeaveQuantity.minus(quantity);
      }
      const recurring: PayrollRecurringEntry[] = employee.recurringElements.map((item) => ({
        element: toElement(item.payElement),
        amount: item.amount?.toString() ?? null,
        quantity: item.quantity?.toString() ?? null,
        validFrom: item.validFrom,
        validTo: item.validTo,
      }));
      const leaveDateInPeriod = employee.leaveDate !== null && employee.leaveDate >= start && employee.leaveDate <= end;
      const asOfDate = employee.leaveDate && employee.leaveDate < end ? employee.leaveDate : end;
      const asOfSalary = latestEffectiveOnDate(employee.salaries, asOfDate) ?? salary;
      const fullAllowances = employee.recurringElements
        .filter((item) => item.payElement.isFixedAllowance && item.validFrom <= asOfDate && (!item.validTo || item.validTo >= asOfDate))
        .map((item) => item.amount ?? new Decimal(0));
      const lastWage = fullAllowances.reduce<Decimal>((sum, amount) => sum.plus(amount), asOfSalary.basicSalary);
      const unpaidRanges = unpaidLeaveRanges
        .filter((request) => request.employeeId === employee.id && request.startDate <= asOfDate)
        .map(({ startDate, endDate }) => ({ startDate, endDate }));
      const service = calculateServiceYears({
        hireDate: employee.hireDate,
        leaveDate: asOfDate,
        unpaidLeaveRanges: unpaidRanges,
      });
      const eosProvision = employee.sscCovered ? new Decimal(0) : calculateEos(lastWage, service.serviceYears);
      if (leaveDateInPeriod && (!encashmentElement || !encashmentElement.isActive)) {
        throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'The LEAVE_ENCASHMENT system element is missing or inactive');
      }
      if (leaveDateInPeriod && annualLeaveType && encashmentElement) {
        const annualSettings = leaveSettings.filter((row) => row.effectiveFrom <= asOfDate);
        const startYear = employee.hireDate.getUTCFullYear();
        const year = asOfDate.getUTCFullYear();
        const entitlements = new Map<number, Decimal>();
        const taken = new Map<number, Decimal>();
        const adjustments = new Map<number, Decimal>();
        for (const adjustment of annualAdjustments) {
          if (adjustment.employeeId === employee.id) {
            adjustments.set(adjustment.year, (adjustments.get(adjustment.year) ?? new Decimal(0)).plus(adjustment.days));
          }
        }
        for (const request of annualRequests) {
          if (request.employeeId === employee.id) {
            const requestYear = request.startDate.getUTCFullYear();
            taken.set(requestYear, (taken.get(requestYear) ?? new Decimal(0)).plus(request.days));
          }
        }
        for (let balanceYear = startYear; balanceYear < year; balanceYear++) {
          const yearEnd = periodBounds(`${balanceYear}-12`).end;
          const annualSetting = annualSettings.filter((row) => row.effectiveFrom <= yearEnd).at(-1);
          entitlements.set(balanceYear, annualLeaveEntitlement({
            year: balanceYear,
            hireDate: employee.hireDate,
            leaveDate: employee.leaveDate,
            annualLeaveDays: annualSetting?.annualLeaveDays ?? '14',
            annualLeaveDaysSenior: annualSetting?.annualLeaveDaysSenior ?? '21',
            annualLeaveSeniorYears: annualSetting?.annualLeaveSeniorYears ?? 5,
            adjustments: adjustments.get(balanceYear) ?? 0,
          }));
        }
        const annualSetting = annualSettings.at(-1);
        const unusedDays = carryIntoYear({ year, startYear, entitlements, taken })
          .plus(annualLeaveEntitlement({
            year,
            hireDate: employee.hireDate,
            leaveDate: employee.leaveDate,
            annualLeaveDays: annualSetting?.annualLeaveDays ?? '14',
            annualLeaveDaysSenior: annualSetting?.annualLeaveDaysSenior ?? '21',
            annualLeaveSeniorYears: annualSetting?.annualLeaveSeniorYears ?? 5,
            asOfDate,
          }))
          .plus(adjustments.get(year) ?? 0)
          .minus(taken.get(year) ?? 0);
        const encashment = calculateLeaveEncashment({
          unusedDays,
          lastWage,
          daysPerMonth: annualSetting?.daysPerMonth ?? settings.daysPerMonth,
        });
        if (encashment.gt(0)) {
          inputs.push({
            element: toElement(encashmentElement),
            amount: encashment,
            quantity: null,
          });
        }
      }
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
          taxPersonalExemption: settings.taxPersonalExemption.toString(),
          taxDependantsExemption: settings.taxDependantsExemption.toString(),
          taxNationalThreshold: settings.taxNationalThreshold.toString(),
          taxNationalRate: settings.taxNationalRate.toString(),
          taxBrackets: settings.taxBrackets.map((bracket) => ({
            upTo: bracket.upTo?.toString() ?? null,
            rate: bracket.rate.toString(),
          })),
        },
        inputs: [...inputs, ...leaveInputs],
        recurring,
        incomeTax: oldTaxes.get(employee.id),
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
          taxableIncome: calculation.taxableIncome,
          incomeTax: calculation.incomeTax,
          nationalContribution: calculation.nationalContribution,
          taxManual: oldTaxes.has(employee.id),
          deductions: calculation.deductions,
          net: calculation.net,
          eosProvision,
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
            payrollMovementId: item.payrollMovementId ?? null,
            leaveRequestId: item.leaveRequestId ?? null,
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
      await tx.payrollLine.update({ where: { id: lineId }, data: { incomeTax, net, taxManual: true } });
      await tx.payrollRun.update({
        where: { id: runId },
        data: {
          incomeTaxTotal: round3(run.incomeTaxTotal.minus(line.incomeTax).plus(incomeTax)),
          netTotal: round3(run.netTotal.minus(line.net).plus(net)),
        },
      });
      return { id: lineId.toString(), incomeTax: incomeTax.toString(), net: net.toString(), taxManual: true };
    }, POSTING_TX_OPTIONS);
  }

  async clearIncomeTax(runId: bigint, lineId: bigint) {
    this.canManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${runId} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id: runId } });
      const line = await tx.payrollLine.findFirst({ where: { id: lineId, payrollRunId: runId } });
      if (!run || !line) throw DomainError.notFound('PayrollLine', lineId.toString());
      if (run.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Tax can only be edited on a draft');
      await tx.payrollLine.update({ where: { id: lineId }, data: { taxManual: false } });
      const manualLines = await tx.payrollLine.findMany({ where: { payrollRunId: runId, taxManual: true } });
      await this.computeRun(
        tx,
        tenantId,
        companyId,
        runId,
        run.period,
        new Map(manualLines.map((manualLine) => [manualLine.employeeId, manualLine.incomeTax.toString()])),
      );
      const updated = await tx.payrollLine.findFirst({ where: { payrollRunId: runId, employeeId: line.employeeId } });
      if (!updated) throw DomainError.notFound('PayrollLine', lineId.toString());
      return {
        id: updated.id.toString(),
        incomeTax: updated.incomeTax.toString(),
        net: updated.net.toString(),
        taxManual: updated.taxManual,
      };
    }, POSTING_TX_OPTIONS);
  }

  async postRun(id: bigint) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payroll_runs WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const draft = await tx.payrollRun.findFirst({
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
      if (!draft) throw DomainError.notFound('PayrollRun', id.toString());
      if (draft.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft runs can be posted');
      const laterRun = await tx.payrollRun.findFirst({
        where: { companyId, period: { gt: draft.period }, status: { in: ['POSTED', 'PAID'] } },
        select: { id: true },
      });
      if (laterRun) throw new DomainError(ErrorCode.PAYROLL_LATER_RUN_POSTED, 'A later payroll period is already posted');
      const taxes = new Map(draft.lines.filter((line) => line.taxManual).map((line) => [line.employeeId, line.incomeTax.toString()]));
      await this.computeRun(tx, tenantId, companyId, id, draft.period, taxes);
      const run = await tx.payrollRun.findFirst({
        where: { id },
        include: {
          lines: {
            include: {
              employee: { select: { branchId: true, costCenterId: true, hireDate: true, leaveDate: true } },
              items: {
                include: {
                  payElement: {
                    select: { accountId: true, isFixedAllowance: true, account: { select: { accountType: true } } },
                  },
                },
              },
            },
          },
        },
      });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.lines.length === 0) {
        throw new DomainError(ErrorCode.PAYROLL_NO_EMPLOYEES, 'No eligible employees for payroll period');
      }
      if (run.lines.some((line) => line.net.lt(0))) throw new DomainError(ErrorCode.PAYROLL_NEGATIVE_NET, 'Payroll net cannot be negative');
      const mappings = await tx.accountMapping.findMany({ where: { mappingKey: { in: [...MAPPING_KEYS] } } });
      const map = new Map(mappings.map((row) => [row.mappingKey, row.accountId]));
      const accountId = (key: (typeof MAPPING_KEYS)[number]) => {
        const idForMapping = map.get(key);
        if (!idForMapping) throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, `Missing mapping ${key}`);
        return idForMapping;
      };
      const periodEnd = periodBounds(run.period).end;
      const year = periodEnd.getUTCFullYear();
      const annualLeaveType = await tx.leaveType.findFirst({ where: { category: 'ANNUAL', isActive: true } });
      const employeesWithLines = run.lines.map((line) => line.employeeId);
      const priorRuns = await tx.payrollRun.findMany({
        where: {
          period: { lt: run.period },
          status: { in: ['POSTED', 'PAID'] },
          lines: { some: { employeeId: { in: employeesWithLines } } },
        },
        include: { lines: { where: { employeeId: { in: employeesWithLines } }, select: { employeeId: true, leaveProvision: true, eosProvision: true } } },
        orderBy: [{ period: 'desc' }],
      });
      const [leaveSettings, annualRequests, leaveAdjustments, leaveHolidays] = annualLeaveType
        ? await Promise.all([
            tx.payrollSettings.findMany({ where: { effectiveFrom: { lte: periodEnd } }, orderBy: [{ effectiveFrom: 'asc' }] }),
            tx.leaveRequest.findMany({
              where: {
                employeeId: { in: employeesWithLines },
                leaveTypeId: annualLeaveType.id,
                status: 'APPROVED',
                startDate: { lte: periodEnd },
              },
              select: { employeeId: true, startDate: true, endDate: true, days: true },
            }),
            tx.leaveBalanceAdjustment.findMany({
              where: { employeeId: { in: employeesWithLines }, leaveTypeId: annualLeaveType.id, year: { lte: year } },
              select: { employeeId: true, year: true, days: true },
            }),
            tx.publicHoliday.findMany({ where: { date: { lte: periodEnd } }, select: { date: true } }),
          ])
        : [[], [], [], []] as const;
      const priorProvision = new Map<bigint, Decimal>();
      const priorEosProvision = new Map<bigint, Decimal>();
      for (const prior of priorRuns) {
        for (const priorLine of prior.lines) {
          if (!priorProvision.has(priorLine.employeeId)) priorProvision.set(priorLine.employeeId, priorLine.leaveProvision);
          if (!priorEosProvision.has(priorLine.employeeId)) priorEosProvision.set(priorLine.employeeId, priorLine.eosProvision);
        }
      }
      for (const line of run.lines) {
        let provision = new Decimal(0);
        if (annualLeaveType && !(line.employee.leaveDate && line.employee.leaveDate <= periodEnd)) {
          const startYear = line.employee.hireDate.getUTCFullYear();
          const entitlements = new Map<number, Decimal>();
          const taken = new Map<number, Decimal>();
          const adjustmentByYear = new Map<number, Decimal>();
          for (const adjustment of leaveAdjustments) {
            if (adjustment.employeeId === line.employeeId) {
              adjustmentByYear.set(adjustment.year, (adjustmentByYear.get(adjustment.year) ?? new Decimal(0)).plus(adjustment.days));
            }
          }
          for (const request of annualRequests) {
            if (request.employeeId === line.employeeId) {
              const requestYear = request.startDate.getUTCFullYear();
              const yearStart = new Date(Date.UTC(requestYear, 0, 1));
              const startDate = request.startDate > yearStart ? request.startDate : yearStart;
              const endDate = request.endDate < periodEnd ? request.endDate : periodEnd;
              if (endDate >= startDate) {
                const settings = leaveSettings.filter((setting) => setting.effectiveFrom <= endDate).at(-1);
                const days = request.endDate <= periodEnd
                  ? request.days
                  : countLeaveDays({
                      startDate,
                      endDate,
                      countBasis: annualLeaveType.countBasis,
                      weeklyRestDays: (settings?.weeklyRestDays ?? '5').split(',').map(Number),
                      holidays: leaveHolidays.map((holiday) => holiday.date),
                    }).days;
                taken.set(requestYear, (taken.get(requestYear) ?? new Decimal(0)).plus(days));
              }
            }
          }
          for (let balanceYear = startYear; balanceYear < year; balanceYear++) {
            const yearEnd = periodBounds(`${balanceYear}-12`).end;
            const yearSettings = leaveSettings.filter((setting) => setting.effectiveFrom <= yearEnd).at(-1);
            entitlements.set(balanceYear, annualLeaveEntitlement({
              year: balanceYear,
              hireDate: line.employee.hireDate,
              leaveDate: line.employee.leaveDate,
              annualLeaveDays: yearSettings?.annualLeaveDays ?? '14',
              annualLeaveDaysSenior: yearSettings?.annualLeaveDaysSenior ?? '21',
              annualLeaveSeniorYears: yearSettings?.annualLeaveSeniorYears ?? 5,
              adjustments: adjustmentByYear.get(balanceYear) ?? 0,
            }));
          }
          const currentSettings = leaveSettings.filter((setting) => setting.effectiveFrom <= periodEnd).at(-1);
          const carry = carryIntoYear({ year, startYear, entitlements, taken });
          const accruedToDate = annualLeaveEntitlement({
            year,
            hireDate: line.employee.hireDate,
            leaveDate: line.employee.leaveDate,
            annualLeaveDays: currentSettings?.annualLeaveDays ?? '14',
            annualLeaveDaysSenior: currentSettings?.annualLeaveDaysSenior ?? '21',
            annualLeaveSeniorYears: currentSettings?.annualLeaveSeniorYears ?? 5,
            asOfDate: periodEnd,
          });
          const unusedDays = carry
            .plus(accruedToDate)
            .plus(adjustmentByYear.get(year) ?? 0)
            .minus(taken.get(year) ?? 0);
          const fixedAllowances = line.items
            .filter((item) => item.payElement?.isFixedAllowance && item.payrollMovementId === null && item.leaveRequestId === null)
            .map((item) => item.amount);
          provision = calculateLeaveProvision({
            unusedDays,
            basic: line.basic,
            fixedAllowances,
            daysPerMonth: currentSettings?.daysPerMonth ?? '30',
          });
        }
        await tx.payrollLine.update({ where: { id: line.id }, data: { leaveProvision: provision } });
        line.leaveProvision = provision;
      }
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
        const key = `${glAccount}:${side}:${branchId ?? ''}:${costCenterId ?? ''}:${description}`;
        const entry = grouped.get(key) ?? {
          accountId: glAccount, branchId, costCenterId, debit: new Decimal(0), credit: new Decimal(0), description,
        };
        entry[side] = entry[side].plus(amount);
        grouped.set(key, entry);
      };
      let recurringDeductionCredits = new Decimal(0);
      for (const line of run.lines) {
        add(accountId('PAYROLL_SALARIES_EXPENSE'), line.basic, 'debit', line.employee.branchId, line.employee.costCenterId, 'Basic salaries');
        add(accountId('PAYROLL_SSC_EXPENSE'), line.sscEmployer, 'debit', line.employee.branchId, line.employee.costCenterId, 'Employer social security');
        for (const item of line.items) {
          if (!item.payElement?.accountId || !item.payElement.account) throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'Payroll item has no account');
          if (item.payrollMovementId !== null) continue;
          if (item.kind === 'DEDUCTION') recurringDeductionCredits = recurringDeductionCredits.plus(item.amount);
          add(
            item.payElement.accountId,
            item.amount,
            item.kind === 'EARNING' ? 'debit' : 'credit',
            line.employee.branchId,
            isIncomeStatement(item.payElement.account.accountType) ? line.employee.costCenterId : null,
            item.description,
          );
        }
      }
      const leaveExpenseAccount = accountId('PAYROLL_LEAVE_EXPENSE');
      const leaveProvisionAccount = accountId('PAYROLL_LEAVE_PROVISION');
      const eosExpenseAccount = accountId('PAYROLL_EOS_EXPENSE');
      const eosProvisionAccount = accountId('PAYROLL_EOS_PROVISION');
      const leaveProvisionLines: JournalLineInput[] = [];
      for (const line of run.lines) {
        const delta = round3(line.leaveProvision.minus(priorProvision.get(line.employeeId) ?? 0));
        if (delta.isZero()) continue;
        const amount = delta.abs();
        const debitExpense = delta.gt(0);
        leaveProvisionLines.push(
          {
            accountId: leaveExpenseAccount,
            debit: debitExpense ? amount : 0,
            credit: debitExpense ? 0 : amount,
            branchId: line.employee.branchId,
            costCenterId: line.employee.costCenterId,
            description: 'Leave provision expense',
          },
          {
            accountId: leaveProvisionAccount,
            debit: debitExpense ? 0 : amount,
            credit: debitExpense ? amount : 0,
            branchId: line.employee.branchId,
            description: 'Accrued leave provision',
          },
        );
      }
      for (const line of run.lines) {
        const delta = round3(line.eosProvision.minus(priorEosProvision.get(line.employeeId) ?? 0));
        if (delta.isZero()) continue;
        const amount = delta.abs();
        const debitExpense = delta.gt(0);
        leaveProvisionLines.push(
          {
            accountId: eosExpenseAccount,
            debit: debitExpense ? amount : 0,
            credit: debitExpense ? 0 : amount,
            branchId: line.employee.branchId,
            costCenterId: line.employee.costCenterId,
            description: 'End-of-service provision expense',
          },
          {
            accountId: eosProvisionAccount,
            debit: debitExpense ? 0 : amount,
            credit: debitExpense ? amount : 0,
            branchId: line.employee.branchId,
            description: 'End-of-service provision',
          },
        );
      }
      add(accountId('PAYROLL_SSC_PAYABLE'), run.sscEmployeeTotal.plus(run.sscEmployerTotal), 'credit', null, null, 'Social security payable');
      add(accountId('PAYROLL_TAX_PAYABLE'), run.incomeTaxTotal, 'credit', null, null, 'Income tax withheld');
      const totalDebits = [...grouped.values()].reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
      const payrollPayable = round3(
        totalDebits
          .minus(run.sscEmployeeTotal.plus(run.sscEmployerTotal))
          .minus(run.incomeTaxTotal)
          .minus(recurringDeductionCredits),
      );
      add(
        accountId('PAYROLL_PAYABLE'),
        payrollPayable.abs(),
        payrollPayable.lt(0) ? 'debit' : 'credit',
        null,
        null,
        'Net salaries payable',
      );
      const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, run.runDate);
      const runNo = await allocateDocumentNo(tx, tenantId, companyId, 'PAYROLL_RUN', run.runDate);
      const journalLines = [...grouped.values()].map((line): JournalLineInput => ({
        accountId: line.accountId,
        debit: line.debit,
        credit: line.credit,
        branchId: line.branchId,
        costCenterId: line.costCenterId,
        description: line.description,
      }));
      const entry = journalLines.length
        ? await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: run.runDate,
            fiscalPeriodId: period.id,
            sourceType: 'PAYROLL_RUN',
            sourceId: run.id,
            description: `Payroll ${run.period}`,
            lines: journalLines,
            requireCostCenters: true,
            postedBy: ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null,
          })
        : null;
      const leaveProvisionEntry = leaveProvisionLines.length
        ? await this.posting.postEntry(tx, {
            tenantId,
            companyId,
            entryDate: run.runDate,
            fiscalPeriodId: period.id,
            sourceType: 'PAYROLL_LEAVE_PROVISION',
            sourceId: run.id,
            description: `Leave provision ${run.period}`,
            lines: leaveProvisionLines,
            requireCostCenters: true,
            postedBy: ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null,
          })
        : null;
      await tx.payrollRun.update({
        where: { id },
        data: { status: 'POSTED', runNo, journalEntryId: entry?.id ?? null, leaveProvisionEntryId: leaveProvisionEntry?.id ?? null },
      });
      await this.audit.log({ action: 'payroll.post', entityType: 'payroll_run', entityId: id, after: { status: 'POSTED' } }, tx);
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
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({ where: { id } });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'POSTED') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted runs can be paid');
      if (payDate < run.runDate) {
        throw new DomainError(ErrorCode.VALIDATION, 'Payment date must not precede the payroll run date');
      }
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
        postedBy: userId,
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
      await this.audit.log({ action: 'payroll.pay', entityType: 'payroll_run', entityId: id, after: { status: 'PAID' } }, tx);
    }, POSTING_TX_OPTIONS);
    return this.getRun(id.toString());
  }

  async reverseRun(id: bigint, reversalDate: Date) {
    this.canPost();
    const { tenantId, companyId, db } = this.context();
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const run = await tx.payrollRun.findFirst({
        where: { id },
        include: { lines: { select: { employeeId: true } } },
      });
      if (!run) throw DomainError.notFound('PayrollRun', id.toString());
      if (run.status !== 'POSTED' && run.status !== 'PAID') {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted or paid runs can be reversed');
      }
      const laterRun = await tx.payrollRun.findFirst({
        where: { companyId, period: { gt: run.period }, status: { in: ['POSTED', 'PAID'] } },
        select: { id: true },
      });
      if (laterRun) throw new DomainError(ErrorCode.PAYROLL_LATER_RUN_POSTED, 'A later payroll period is already posted');
      const activeSettlement = await tx.payrollSettlement.findFirst({
        where: {
          companyId,
          employeeId: { in: run.lines.map((line) => line.employeeId) },
          status: { in: ['POSTED', 'PAID'] },
        },
        select: { id: true },
      });
      if (activeSettlement) {
        throw new DomainError(ErrorCode.PAYROLL_SETTLEMENT_ACTIVE, 'Payroll run has an active final settlement');
      }
      if (reversalDate < run.runDate) {
        throw new DomainError(ErrorCode.VALIDATION, 'Payroll reversal date cannot be before the run date');
      }
      if (!run.journalEntryId) {
        await this.posting.resolveOpenPeriod(tx, tenantId, companyId, reversalDate);
      }
      if (run.status === 'PAID' && run.paymentEntryId) {
        await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: run.paymentEntryId, reversalDate, postedBy: userId });
      }
      if (run.journalEntryId) {
        await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: run.journalEntryId, reversalDate, postedBy: userId });
      }
      if (run.leaveProvisionEntryId) {
        await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: run.leaveProvisionEntryId, reversalDate, postedBy: userId });
      }
      await tx.payrollRun.update({ where: { id }, data: { status: 'REVERSED' } });
      await this.audit.log({ action: 'payroll.reverse', entityType: 'payroll_run', entityId: id, after: { status: 'REVERSED' } }, tx);
    }, POSTING_TX_OPTIONS);
    return this.getRun(id.toString());
  }

  async employeeStatement(employeeId: bigint, fromValue: string, toValue: string) {
    const from = date(fromValue);
    const to = date(toValue);
    if (from > to) throw new DomainError(ErrorCode.VALIDATION, 'Statement start date must not be after end date');
    const { db } = this.context();
    const employee = await db.employee.findFirst({ where: { id: employeeId }, select: { id: true, nameAr: true } });
    if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
    const movements = await db.payrollMovement.findMany({
      where: { employeeId },
      include: {
        payElement: { select: { kind: true } },
        reversalEntry: { select: { createdAt: true } },
      },
    });
    const runs = await db.payrollRun.findMany({
      where: {
        status: { in: ['POSTED', 'PAID', 'REVERSED'] },
        lines: { some: { employeeId } },
      },
      include: {
        lines: { where: { employeeId }, include: { items: true } },
        journalEntry: { include: { reversals: { select: { entryDate: true, createdAt: true } } } },
        paymentEntry: { include: { reversals: { select: { entryDate: true, createdAt: true } } } },
      },
    });
    const settlements = await db.payrollSettlement.findMany({
      where: { employeeId, status: { in: ['POSTED', 'PAID', 'REVERSED'] } },
      include: {
        paymentEntry: { select: { entryDate: true, createdAt: true, entryNo: true } },
        reversalEntry: { select: { entryDate: true, createdAt: true, entryNo: true } },
        paymentReversalEntry: { select: { entryDate: true, createdAt: true, entryNo: true } },
      },
    });

    type StatementEvent = {
      date: Date;
      createdAt: Date;
      order: number;
      documentNo: string;
      documentType: string;
      description: string;
      signed: Decimal;
    };
    const events: StatementEvent[] = [];
    let order = 0;
    const addEvent = (event: Omit<StatementEvent, 'order'>) => events.push({ ...event, order: order++ });
    for (const movement of movements) {
      const signed = movement.payElement.kind === 'EARNING' ? movement.amount : movement.amount.neg();
      addEvent({
        date: movement.movementDate,
        createdAt: movement.createdAt,
        documentNo: movement.movementNo ?? movement.id.toString(),
        documentType: 'MOVEMENT',
        description: movement.description,
        signed,
      });
      if (movement.status === 'REVERSED' && movement.reversalEntry && movement.reversedAt) {
        addEvent({
          date: movement.reversedAt,
          createdAt: movement.reversalEntry.createdAt,
          documentNo: movement.movementNo ?? movement.id.toString(),
          documentType: 'MOVEMENT_REVERSAL',
          description: movement.description,
          signed: signed.neg(),
        });
      }
    }
    for (const run of runs) {
      const line = run.lines[0];
      if (!line) continue;
      const movementNet = line.items.reduce((sum, item) => {
        if (item.payrollMovementId === null) return sum;
        return item.kind === 'EARNING' ? sum.plus(item.amount) : sum.minus(item.amount);
      }, new Decimal(0));
      const runBalance = round3(line.net.minus(movementNet));
      addEvent({
        date: run.runDate,
        createdAt: run.createdAt,
        documentNo: run.runNo ?? run.id.toString(),
        documentType: 'PAYROLL_RUN',
        description: `Payroll ${run.period}`,
        signed: runBalance,
      });
      const runReversal = run.journalEntry?.reversals[0];
      if (run.status === 'REVERSED' && runReversal) {
        addEvent({
          date: runReversal.entryDate,
          createdAt: runReversal.createdAt,
          documentNo: run.runNo ?? run.id.toString(),
          documentType: 'PAYROLL_RUN_REVERSAL',
          description: `Payroll ${run.period}`,
          signed: runBalance.neg(),
        });
      }
      if (run.paymentEntry && (run.status === 'PAID' || run.status === 'REVERSED')) {
        const payment = line.net.neg();
        addEvent({
          date: run.paymentEntry.entryDate,
          createdAt: run.paymentEntry.createdAt,
          documentNo: run.paymentEntry.entryNo ?? run.runNo ?? run.id.toString(),
          documentType: 'PAYROLL_PAYMENT',
          description: `Payroll payment ${run.period}`,
          signed: payment,
        });
        const paymentReversal = run.paymentEntry.reversals[0];
        if (run.status === 'REVERSED' && paymentReversal) {
          addEvent({
            date: paymentReversal.entryDate,
            createdAt: paymentReversal.createdAt,
            documentNo: run.paymentEntry.entryNo ?? run.runNo ?? run.id.toString(),
            documentType: 'PAYROLL_PAYMENT_REVERSAL',
            description: `Payroll payment ${run.period}`,
            signed: payment.neg(),
          });
        }
      }
    }
    for (const settlement of settlements) {
      const settlementNo = settlement.settlementNo ?? settlement.id.toString();
      addEvent({
        date: settlement.settlementDate,
        createdAt: settlement.createdAt,
        documentNo: settlementNo,
        documentType: 'PAYROLL_SETTLEMENT',
        description: 'Final settlement',
        signed: settlement.net,
      });
      if ((settlement.status === 'PAID' || settlement.status === 'REVERSED') && settlement.paymentEntry) {
        addEvent({
          date: settlement.paymentEntry.entryDate,
          createdAt: settlement.paymentEntry.createdAt,
          documentNo: settlement.paymentEntry.entryNo ?? settlementNo,
          documentType: 'PAYROLL_SETTLEMENT_PAYMENT',
          description: 'Final settlement payment',
          signed: settlement.net.neg(),
        });
      }
      if (settlement.status === 'REVERSED' && settlement.paymentReversalEntry) {
        addEvent({
          date: settlement.paymentReversalEntry.entryDate,
          createdAt: settlement.paymentReversalEntry.createdAt,
          documentNo: settlement.paymentReversalEntry.entryNo ?? settlementNo,
          documentType: 'PAYROLL_SETTLEMENT_PAYMENT_REVERSAL',
          description: 'Final settlement payment',
          signed: settlement.net,
        });
      }
      if (settlement.status === 'REVERSED' && settlement.reversalEntry) {
        addEvent({
          date: settlement.reversalEntry.entryDate,
          createdAt: settlement.reversalEntry.createdAt,
          documentNo: settlement.reversalEntry.entryNo ?? settlementNo,
          documentType: 'PAYROLL_SETTLEMENT_REVERSAL',
          description: 'Final settlement',
          signed: settlement.net.neg(),
        });
      }
    }
    events.sort((a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.order - b.order,
    );
    const openingBalance = events
      .filter((event) => event.date < from)
      .reduce((sum, event) => sum.plus(event.signed), new Decimal(0));
    let balance = openingBalance;
    const money = (amount: Decimal) => {
      const value = round3(amount).toString();
      const separator = value.indexOf('.');
      const integer = separator < 0 ? value : value.slice(0, separator);
      const fraction = separator < 0 ? '' : value.slice(separator + 1);
      return `${integer}.${fraction.padEnd(3, '0')}`;
    };
    const rows = events
      .filter((event) => event.date >= from && event.date <= to)
      .map((event) => {
        balance = round3(balance.plus(event.signed));
        const amount = round3(event.signed.abs());
        return {
          date: event.date.toISOString().slice(0, 10),
          documentNo: event.documentNo,
          documentType: event.documentType,
          description: event.description,
          debit: event.signed.lt(0) ? money(amount) : '0.000',
          credit: event.signed.gt(0) ? money(amount) : '0.000',
          balance: money(balance),
        };
      });
    return {
      employeeId: employee.id.toString(),
      employeeName: employee.nameAr,
      from: fromValue,
      to: toValue,
      openingBalance: money(openingBalance),
      closingBalance: money(balance),
      rows,
    };
  }

  async listRuns() {
    const { db } = this.context();
    const runs = await db.payrollRun.findMany({ orderBy: [{ period: 'desc' }, { id: 'desc' }] });
    return runs.map((run) => this.runDto(run));
  }

  async getRun(idOrPeriod: string, byPeriod = false, language: 'ar' | 'en' = 'en') {
    const { db } = this.context();
    const run = await db.payrollRun.findFirst({
      where: byPeriod ? { period: idOrPeriod } : { id: BigInt(idOrPeriod) },
      include: {
        lines: {
          include: {
            employee: { select: { nameAr: true } },
            items: {
              select: {
                description: true, kind: true, amount: true, quantity: true, rate: true,
                payrollMovementId: true, leaveRequestId: true,
                payElement: { select: { nameAr: true, nameEn: true } },
              },
            },
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
        taxableIncome: line.taxableIncome.toString(),
        incomeTax: line.incomeTax.toString(),
        nationalContribution: line.nationalContribution.toString(),
        taxManual: line.taxManual,
        deductions: line.deductions.toString(),
        net: line.net.toString(),
        leaveProvision: line.leaveProvision.toString(),
        eosProvision: line.eosProvision.toString(),
        items: line.items.map((item) => ({
          description: language === 'ar'
            ? item.payElement?.nameAr ?? item.description
            : item.payElement?.nameEn ?? item.payElement?.nameAr ?? item.description,
          kind: item.kind,
          amount: item.amount.toString(),
          quantity: item.quantity?.toString() ?? null,
          rate: item.rate?.toString() ?? null,
          payrollMovementId: item.payrollMovementId?.toString() ?? null,
          leaveRequestId: item.leaveRequestId?.toString() ?? null,
        })),
      })),
    };
  }

  private runDto(run: {
    id: bigint; period: string; runDate: Date; status: string; runNo: string | null; leaveProvisionEntryId: bigint | null; basicTotal: Decimal; earningsTotal: Decimal;
    grossTotal: Decimal; sscBaseTotal: Decimal; sscEmployeeTotal: Decimal; sscEmployerTotal: Decimal;
    incomeTaxTotal: Decimal; deductionsTotal: Decimal; netTotal: Decimal;
  }) {
    return {
      id: run.id.toString(),
      period: run.period,
      runDate: run.runDate.toISOString().slice(0, 10),
      status: run.status,
      runNo: run.runNo,
      leaveProvisionEntryId: run.leaveProvisionEntryId?.toString() ?? null,
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
