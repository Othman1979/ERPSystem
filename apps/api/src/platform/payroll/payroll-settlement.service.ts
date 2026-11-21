import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { calendarDate } from '../../common/validation/calendar-date.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { PostingService } from '../journal/posting.service.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import { calculateEos, calculateEosTax, calculateServiceYears } from './settlement-calculator.js';
import type {
  CreatePayrollSettlementDto,
  ListPayrollSettlementsQueryDto,
  PayrollSettlementPaymentDto,
  ReversePayrollSettlementDto,
} from './dto/payroll-settlement.dto.js';

function date(value: string): Date {
  return calendarDate(value, 'date');
}

function asDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class PayrollSettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  private context() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const companyId = cls.get('companyId');
    if (!tenantId || !companyId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant/company selected');
    return { tenantId, companyId, db: this.prisma.forTenant(tenantId) };
  }

  private requirePermission(permission: string) {
    if (!ClsServiceManager.getClsService<RequestContext>().get('permissions')?.has(permission)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Missing payroll permission');
    }
  }

  private dto(row: Prisma.PayrollSettlementGetPayload<{
    include: { employee: { select: { nameAr: true } } };
  }>) {
    return {
      id: row.id.toString(),
      employeeId: row.employeeId.toString(),
      employeeNameAr: row.employee.nameAr,
      settlementNo: row.settlementNo,
      settlementDate: asDate(row.settlementDate),
      status: row.status,
      serviceYears: row.serviceYears.toString(),
      lastWage: row.lastWage.toString(),
      eosAmount: row.eosAmount.toString(),
      serviceDaysBefore2010: row.serviceDaysBefore2010,
      serviceDays2010To2014: row.serviceDays2010To2014,
      serviceDaysFrom2015: row.serviceDaysFrom2015,
      taxableAmount: row.taxableAmount.toString(),
      eosTax: row.eosTax.toString(),
      nationalContribution: row.nationalContribution.toString(),
      provisionUsed: row.provisionUsed.toString(),
      net: row.net.toString(),
      journalEntryId: row.journalEntryId?.toString() ?? null,
      paymentEntryId: row.paymentEntryId?.toString() ?? null,
      reversalEntryId: row.reversalEntryId?.toString() ?? null,
      paymentReversalEntryId: row.paymentReversalEntryId?.toString() ?? null,
      paidFromCashBoxId: row.paidFromCashBoxId?.toString() ?? null,
      paidFromBankAccountId: row.paidFromBankAccountId?.toString() ?? null,
      postedAt: row.postedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      reversedAt: row.reversedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(query: ListPayrollSettlementsQueryDto) {
    this.requirePermission(PERMISSIONS.PAYROLL_VIEW);
    const { companyId, db } = this.context();
    const rows = await db.payrollSettlement.findMany({
      where: {
        companyId,
        ...(query.employeeId ? { employeeId: BigInt(query.employeeId) } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: { employee: { select: { nameAr: true } } },
      orderBy: [{ settlementDate: 'desc' }, { id: 'desc' }],
    });
    return rows.map((row) => this.dto(row));
  }

  async create(dto: CreatePayrollSettlementDto) {
    this.requirePermission(PERMISSIONS.PAYROLL_MANAGE);
    const { tenantId, companyId, db } = this.context();
    const employeeId = BigInt(dto.employeeId);
    const id = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const existing = await tx.payrollSettlement.findFirst({
        where: { companyId, employeeId, status: { not: 'REVERSED' } },
        select: { id: true },
      });
      if (existing) throw new DomainError(ErrorCode.PAYROLL_SETTLEMENT_EXISTS, 'An active settlement already exists for this employee');
      const values = await this.calculateDraft(tx, companyId, employeeId);
      const settlement = await tx.payrollSettlement.create({
        data: { tenantId, companyId, employeeId, ...values },
      });
      await this.audit.log({
        action: 'payroll.settlement.create',
        entityType: 'payroll_settlement',
        entityId: settlement.id,
        after: { status: 'DRAFT', employeeId: employeeId.toString() },
      }, tx);
      return settlement.id;
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  async recompute(id: bigint) {
    this.requirePermission(PERMISSIONS.PAYROLL_MANAGE);
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const settlement = await tx.payrollSettlement.findFirst({ where: { id } });
      if (!settlement) throw DomainError.notFound('PayrollSettlement', id.toString());
      if (settlement.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft settlements can be recomputed');
      const values = await this.calculateDraft(tx, companyId, settlement.employeeId);
      await tx.payrollSettlement.update({ where: { id }, data: values });
      await this.audit.log({ action: 'payroll.settlement.recompute', entityType: 'payroll_settlement', entityId: id }, tx);
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  async delete(id: bigint) {
    this.requirePermission(PERMISSIONS.PAYROLL_MANAGE);
    const { tenantId, companyId, db } = this.context();
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const settlement = await tx.payrollSettlement.findFirst({ where: { id } });
      if (!settlement) throw DomainError.notFound('PayrollSettlement', id.toString());
      if (settlement.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft settlements can be deleted');
      await tx.payrollSettlement.delete({ where: { id } });
      await this.audit.log({ action: 'payroll.settlement.delete', entityType: 'payroll_settlement', entityId: id }, tx);
    }, POSTING_TX_OPTIONS);
    return { id: id.toString(), deleted: true };
  }

  async post(id: bigint) {
    this.requirePermission(PERMISSIONS.PAYROLL_POST);
    const { tenantId, companyId, db } = this.context();
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const settlement = await tx.payrollSettlement.findFirst({ where: { id } });
      if (!settlement) throw DomainError.notFound('PayrollSettlement', id.toString());
      if (settlement.status !== 'DRAFT') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only draft settlements can be posted');
      const values = await this.calculateDraft(tx, companyId, settlement.employeeId);
      const current = await tx.payrollSettlement.update({ where: { id }, data: values });
      const getAccount = async (mappingKey: string) => {
        const mapping = await tx.accountMapping.findFirst({ where: { mappingKey } });
        if (!mapping) throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, `Missing ${mappingKey} mapping`);
        return mapping.accountId;
      };
      const [provision, eosExpense, tax, payable] = await Promise.all([
        getAccount('PAYROLL_EOS_PROVISION'),
        getAccount('PAYROLL_EOS_EXPENSE'),
        getAccount('PAYROLL_TAX_PAYABLE'),
        getAccount('PAYROLL_PAYABLE'),
      ]);
      const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, current.settlementDate);
      const settlementNo = await allocateDocumentNo(tx, tenantId, companyId, 'PAYROLL_SETTLEMENT', current.settlementDate);
      const difference = round3(current.eosAmount.minus(current.provisionUsed));
      const lines = [
        ...(current.provisionUsed.gt(0) ? [{ accountId: provision, debit: current.provisionUsed }] : []),
        ...(difference.gt(0) ? [{ accountId: eosExpense, debit: difference }] : []),
        ...(difference.lt(0) ? [{ accountId: eosExpense, credit: difference.abs() }] : []),
        ...(current.eosTax.gt(0) ? [{ accountId: tax, credit: current.eosTax }] : []),
        ...(current.net.gt(0) ? [{ accountId: payable, credit: current.net }] : []),
      ];
      const entry = await this.posting.postEntry(tx, {
        tenantId,
        companyId,
        entryDate: current.settlementDate,
        fiscalPeriodId: period.id,
        sourceType: 'PAYROLL_SETTLEMENT',
        sourceId: id,
        description: `Final settlement ${settlementNo}`,
        lines,
        postedBy: userId,
      });
      await tx.payrollSettlement.update({
        where: { id },
        data: { status: 'POSTED', settlementNo, journalEntryId: entry.id, postedAt: new Date(), postedBy: userId },
      });
      await this.audit.log({ action: 'payroll.settlement.post', entityType: 'payroll_settlement', entityId: id, after: { status: 'POSTED' } }, tx);
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  async pay(id: bigint, dto: PayrollSettlementPaymentDto) {
    this.requirePermission(PERMISSIONS.PAYROLL_POST);
    const { tenantId, companyId, db } = this.context();
    if (!!dto.cashBoxId === !!dto.bankAccountId) throw new DomainError(ErrorCode.VALIDATION, 'Choose exactly one cash box or bank account');
    const paymentDate = date(dto.paymentDate);
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const settlement = await tx.payrollSettlement.findFirst({ where: { id } });
      if (!settlement) throw DomainError.notFound('PayrollSettlement', id.toString());
      if (settlement.status !== 'POSTED') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted settlements can be paid');
      if (paymentDate < settlement.settlementDate) throw new DomainError(ErrorCode.VALIDATION, 'Payment date must not precede settlement date');
      const account = dto.cashBoxId
        ? await tx.cashBox.findFirst({ where: { id: BigInt(dto.cashBoxId), isActive: true } })
        : await tx.bankAccount.findFirst({ where: { id: BigInt(dto.bankAccountId!), isActive: true } });
      if (!account) throw DomainError.notFound('CashBox/BankAccount', dto.cashBoxId ?? dto.bankAccountId!);
      const payable = await tx.accountMapping.findFirst({ where: { mappingKey: 'PAYROLL_PAYABLE' } });
      if (!payable) throw new DomainError(ErrorCode.MAPPING_ACCOUNT_INVALID, 'Missing payroll payable mapping');
      const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, paymentDate);
      const entry = await this.posting.postEntry(tx, {
        tenantId,
        companyId,
        entryDate: paymentDate,
        fiscalPeriodId: period.id,
        sourceType: 'PAYROLL_SETTLEMENT_PAYMENT',
        sourceId: id,
        description: `Final settlement payment ${settlement.settlementNo ?? id}`,
        lines: [
          { accountId: payable.accountId, debit: settlement.net },
          { accountId: account.accountId, credit: settlement.net },
        ],
        postedBy: userId,
      });
      await tx.payrollSettlement.update({
        where: { id },
        data: {
          status: 'PAID', paymentEntryId: entry.id,
          paidFromCashBoxId: dto.cashBoxId ? BigInt(dto.cashBoxId) : null,
          paidFromBankAccountId: dto.bankAccountId ? BigInt(dto.bankAccountId) : null,
          paidAt: new Date(), paidBy: userId,
        },
      });
      await this.audit.log({ action: 'payroll.settlement.pay', entityType: 'payroll_settlement', entityId: id, after: { status: 'PAID' } }, tx);
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  async reverse(id: bigint, dto: ReversePayrollSettlementDto) {
    this.requirePermission(PERMISSIONS.PAYROLL_POST);
    const { tenantId, companyId, db } = this.context();
    const reversalDate = date(dto.reversalDate);
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId') ?? null;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
      const settlement = await tx.payrollSettlement.findFirst({ where: { id } });
      if (!settlement) throw DomainError.notFound('PayrollSettlement', id.toString());
      if (!['POSTED', 'PAID'].includes(settlement.status)) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only posted or paid settlements can be reversed');
      }
      if (reversalDate < settlement.settlementDate) throw new DomainError(ErrorCode.VALIDATION, 'Reversal date must not precede settlement date');
      const paymentReversal = settlement.status === 'PAID' && settlement.paymentEntryId
        ? await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: settlement.paymentEntryId, reversalDate, postedBy: userId })
        : null;
      const postingReversal = settlement.journalEntryId
        ? await this.posting.reverseEntry(tx, { tenantId, companyId, entryId: settlement.journalEntryId, reversalDate, postedBy: userId })
        : null;
      await tx.payrollSettlement.update({
        where: { id },
        data: {
          status: 'REVERSED',
          paymentReversalEntryId: paymentReversal?.id ?? null,
          reversalEntryId: postingReversal?.id ?? null,
          reversedAt: new Date(),
          reversedBy: userId,
        },
      });
      await this.audit.log({ action: 'payroll.settlement.reverse', entityType: 'payroll_settlement', entityId: id, after: { status: 'REVERSED' } }, tx);
    }, POSTING_TX_OPTIONS);
    return this.get(id);
  }

  async get(id: bigint) {
    const { companyId, db } = this.context();
    const row = await db.payrollSettlement.findFirst({
      where: { id, companyId },
      include: { employee: { select: { nameAr: true } } },
    });
    if (!row) throw DomainError.notFound('PayrollSettlement', id.toString());
    return this.dto(row);
  }

  private async calculateDraft(tx: Prisma.TransactionClient, companyId: bigint, employeeId: bigint) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, companyId },
      include: {
        salaries: { orderBy: [{ effectiveFrom: 'desc' }] },
        recurringElements: { include: { payElement: true } },
      },
    });
    if (!employee) throw DomainError.notFound('Employee', employeeId.toString());
    if (!employee.leaveDate || employee.sscCovered) {
      throw new DomainError(ErrorCode.PAYROLL_SETTLEMENT_NOT_ELIGIBLE, 'Settlement requires a non-SSC employee with a leave date');
    }
    const period = `${employee.leaveDate.getUTCFullYear()}-${String(employee.leaveDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const run = await tx.payrollRun.findFirst({
      where: {
        companyId,
        period,
        status: { in: ['POSTED', 'PAID'] },
        lines: { some: { employeeId } },
      },
      include: { lines: { where: { employeeId }, select: { eosProvision: true } } },
    });
    if (!run) throw new DomainError(ErrorCode.PAYROLL_SETTLEMENT_RUN_REQUIRED, 'The leaving-period payroll run must be posted first');
    const settings = await tx.payrollSettings.findFirst({
      where: { effectiveFrom: { lte: employee.leaveDate } },
      orderBy: [{ effectiveFrom: 'desc' }],
    });
    if (!settings) throw new DomainError(ErrorCode.PAYROLL_SETTINGS_REQUIRED, 'No payroll settings in force');
    const salary = employee.salaries.find((row) => row.effectiveFrom <= employee.leaveDate!);
    if (!salary) throw new DomainError(ErrorCode.VALIDATION, 'No salary in force on the leave date');
    const allowances = employee.recurringElements
      .filter((row) => row.payElement.isFixedAllowance && row.validFrom <= employee.leaveDate! && (!row.validTo || row.validTo >= employee.leaveDate!))
      .map((row) => row.amount ?? new Decimal(0));
    const lastWage = allowances.reduce<Decimal>((sum, amount) => sum.plus(amount), salary.basicSalary);
    const unpaid = await tx.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: employee.leaveDate },
        leaveType: { category: 'UNPAID' },
      },
      select: { startDate: true, endDate: true },
    });
    const service = calculateServiceYears({
      hireDate: employee.hireDate,
      leaveDate: employee.leaveDate,
      unpaidLeaveRanges: unpaid,
    });
    const eosAmount = calculateEos(lastWage, service.serviceYears);
    const tax = calculateEosTax({
      eosAmount,
      daysBefore2010: service.daysBefore2010,
      days2010To2014: service.days2010To2014,
      daysFrom2015: service.daysFrom2015,
      exemption: settings.eosTaxExemption,
      taxRate: settings.eosTaxRate,
      nationalThreshold: settings.eosNationalThreshold,
      nationalRate: settings.eosNationalRate,
    });
    return {
      settlementDate: employee.leaveDate,
      serviceYears: service.serviceYears,
      lastWage,
      eosAmount,
      serviceDaysBefore2010: service.daysBefore2010,
      serviceDays2010To2014: service.days2010To2014,
      serviceDaysFrom2015: service.daysFrom2015,
      taxableAmount: tax.taxableAmount,
      eosTax: tax.eosTax,
      nationalContribution: tax.nationalContribution,
      provisionUsed: run.lines[0]?.eosProvision ?? new Decimal(0),
      net: round3(eosAmount.minus(tax.eosTax)),
    };
  }
}
