import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { calendarDate } from '../../common/validation/calendar-date.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { Prisma, type LeaveCategory, type LeaveCountBasis } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';
import { allocateDocumentNo } from '../shared/document-numbering.js';
import {
  annualLeaveEntitlement,
  availableLeaveBalance,
  carryIntoYear,
  countLeaveDays,
} from './leave-calculator.js';
import type {
  CreateLeaveAdjustmentDto,
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreatePublicHolidayDto,
  LeaveAdjustmentsQueryDto,
  LeaveBalanceQueryDto,
  LeaveRequestsQueryDto,
  PublicHolidayQueryDto,
  UpdateLeaveTypeDto,
} from './dto/leave.dto.js';

const TYPE_INCLUDE = { payElement: { select: { id: true, code: true } } } satisfies Prisma.LeaveTypeInclude;
type LeaveTypeRecord = Prisma.LeaveTypeGetPayload<{ include: typeof TYPE_INCLUDE }>;

const REQUEST_INCLUDE = {
  employee: { select: { id: true, nameAr: true, nameEn: true, hireDate: true, leaveDate: true } },
  leaveType: { include: TYPE_INCLUDE },
} satisfies Prisma.LeaveRequestInclude;
type LeaveRequestRecord = Prisma.LeaveRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

function asDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function yearBounds(year: number) {
  return {
    start: new Date(Date.UTC(year, 0, 1)),
    end: new Date(Date.UTC(year, 11, 31)),
  };
}

function yearMonth(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addYears(value: Date, years: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear() + years, value.getUTCMonth(), value.getUTCDate()));
}

function weeklyRestDays(csv: string): number[] {
  return csv.split(',').map((day) => Number(day));
}

function serializeType(row: LeaveTypeRecord) {
  return {
    id: row.id.toString(),
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    category: row.category,
    countBasis: row.countBasis,
    maxDaysPerYear: row.maxDaysPerYear?.toString() ?? null,
    maxDaysPerRequest: row.maxDaysPerRequest?.toString() ?? null,
    hospitalExtraDays: row.hospitalExtraDays?.toString() ?? null,
    oncePerEmployment: row.oncePerEmployment,
    minServiceYears: row.minServiceYears,
    payElementId: row.payElementId?.toString() ?? null,
    payElementCode: row.payElement?.code ?? null,
    isActive: row.isActive,
  };
}

function serializeRequest(row: LeaveRequestRecord) {
  return {
    id: row.id.toString(),
    employeeId: row.employeeId.toString(),
    employeeName: row.employee.nameAr,
    employeeNameEn: row.employee.nameEn,
    leaveTypeId: row.leaveTypeId.toString(),
    leaveTypeCode: row.leaveType.code,
    leaveTypeNameAr: row.leaveType.nameAr,
    leaveTypeNameEn: row.leaveType.nameEn,
    requestNo: row.requestNo,
    startDate: dateString(row.startDate),
    endDate: dateString(row.endDate),
    days: row.days.toString(),
    calendarDays: row.calendarDays,
    hospitalised: row.hospitalised,
    notes: row.notes,
    status: row.status,
    approvedBy: row.approvedBy?.toString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt ? dateString(row.cancelledAt) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class LeaveService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private context() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const companyId = cls.get('companyId');
    if (!tenantId || !companyId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant/company selected');
    return { cls, tenantId, companyId, db: this.prisma.forTenant(tenantId) };
  }

  private assertManage() {
    const permissions = ClsServiceManager.getClsService<RequestContext>().get('permissions');
    if (!permissions?.has(PERMISSIONS.PAYROLL_MANAGE)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Missing payroll management permission');
    }
  }

  private assertApprove() {
    const permissions = ClsServiceManager.getClsService<RequestContext>().get('permissions');
    if (!permissions?.has(PERMISSIONS.PAYROLL_LEAVE_APPROVE)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Missing leave approval permission');
    }
  }

  private async lockCompany(tx: Prisma.TransactionClient, tenantId: bigint, companyId: bigint) {
    await tx.$queryRaw`SELECT id FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`;
  }

  private async findRequest(tx: Prisma.TransactionClient, id: bigint) {
    return tx.leaveRequest.findFirst({ where: { id }, include: REQUEST_INCLUDE });
  }

  async listTypes() {
    const { db } = this.context();
    return (await db.leaveType.findMany({ include: TYPE_INCLUDE, orderBy: [{ code: 'asc' }] })).map(serializeType);
  }

  async createType(dto: CreateLeaveTypeDto) {
    this.assertManage();
    const { tenantId, companyId, db } = this.context();
    const payElement = await this.validatePayElement(db, dto.payElementId);
    const created = await db.leaveType.create({
      data: {
        tenantId,
        companyId,
        code: dto.code,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn ?? null,
        category: dto.category as LeaveCategory,
        countBasis: dto.countBasis as LeaveCountBasis,
        maxDaysPerYear: dto.maxDaysPerYear ?? null,
        maxDaysPerRequest: dto.maxDaysPerRequest ?? null,
        hospitalExtraDays: dto.hospitalExtraDays ?? null,
        oncePerEmployment: dto.oncePerEmployment ?? false,
        minServiceYears: dto.minServiceYears ?? null,
        payElementId: payElement?.id ?? null,
        isActive: dto.isActive ?? true,
      },
      include: TYPE_INCLUDE,
    });
    return serializeType(created);
  }

  async updateType(id: bigint, dto: UpdateLeaveTypeDto) {
    this.assertManage();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await this.lockCompany(tx, tenantId, companyId);
      const type = await tx.leaveType.findFirst({ where: { id }, include: TYPE_INCLUDE });
      if (!type) throw DomainError.notFound('LeaveType', id.toString());
      const payElementId = dto.payElementId === undefined
        ? type.payElementId === null ? undefined : (await this.validatePayElement(tx, type.payElementId.toString()))?.id
        : (await this.validatePayElement(tx, dto.payElementId))?.id ?? null;
      const updated = await tx.leaveType.update({
        where: { id },
        data: {
          nameAr: dto.nameAr,
          nameEn: dto.nameEn,
          category: dto.category as LeaveCategory | undefined,
          countBasis: dto.countBasis as LeaveCountBasis | undefined,
          maxDaysPerYear: dto.maxDaysPerYear,
          maxDaysPerRequest: dto.maxDaysPerRequest,
          hospitalExtraDays: dto.hospitalExtraDays,
          oncePerEmployment: dto.oncePerEmployment,
          minServiceYears: dto.minServiceYears,
          payElementId,
          isActive: dto.isActive,
        },
        include: TYPE_INCLUDE,
      });
      return serializeType(updated);
    }, POSTING_TX_OPTIONS);
  }

  private async validatePayElement(db: Pick<Prisma.TransactionClient, 'payElement'>, id?: string | null) {
    if (!id) return null;
    const element = await db.payElement.findFirst({
      where: { id: BigInt(id), kind: 'DEDUCTION', amountType: 'PER_DAY', isActive: true },
      select: { id: true },
    });
    if (!element) throw new DomainError(ErrorCode.PAYROLL_ACCOUNT_INVALID, 'Leave pay element must be an active PER_DAY deduction');
    return element;
  }

  async listHolidays(query: PublicHolidayQueryDto) {
    const { db } = this.context();
    const rows = await db.publicHoliday.findMany({
      where: query.year ? {
        date: { gte: yearBounds(Number(query.year)).start, lte: yearBounds(Number(query.year)).end },
      } : {},
      orderBy: [{ date: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      date: dateString(row.date),
      nameAr: row.nameAr,
      nameEn: row.nameEn,
    }));
  }

  async createHoliday(dto: CreatePublicHolidayDto) {
    this.assertManage();
    const { tenantId, companyId, db } = this.context();
    const row = await db.publicHoliday.create({
      data: { tenantId, companyId, date: calendarDate(dto.date, 'date'), nameAr: dto.nameAr, nameEn: dto.nameEn ?? null },
    });
    return { id: row.id.toString(), date: dateString(row.date), nameAr: row.nameAr, nameEn: row.nameEn };
  }

  async deleteHoliday(id: bigint) {
    this.assertManage();
    const { db } = this.context();
    const row = await db.publicHoliday.findFirst({ where: { id } });
    if (!row) throw DomainError.notFound('PublicHoliday', id.toString());
    await db.publicHoliday.delete({ where: { id } });
    return { id: id.toString(), deleted: true as const };
  }

  async listRequests(query: LeaveRequestsQueryDto) {
    const { db } = this.context();
    const where: Prisma.LeaveRequestWhereInput = {
      ...(query.employeeId ? { employeeId: BigInt(query.employeeId) } : {}),
      ...(query.status ? { status: query.status as 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' } : {}),
      ...(query.year ? {
        startDate: { lte: yearBounds(Number(query.year)).end },
        endDate: { gte: yearBounds(Number(query.year)).start },
      } : {}),
    };
    const rows = await db.leaveRequest.findMany({ where, include: REQUEST_INCLUDE, orderBy: [{ startDate: 'desc' }, { id: 'desc' }] });
    return rows.map(serializeRequest);
  }

  async createRequest(dto: CreateLeaveRequestDto) {
    const { tenantId, companyId, db, cls } = this.context();
    const startDate = calendarDate(dto.startDate, 'startDate');
    const endDate = calendarDate(dto.endDate, 'endDate');
    if (endDate < startDate) throw new DomainError(ErrorCode.VALIDATION, 'Leave end date precedes start date');
    return db.$transaction(async (tx) => {
      await this.lockCompany(tx, tenantId, companyId);
      const employee = await tx.employee.findFirst({ where: { id: BigInt(dto.employeeId) } });
      const type = await tx.leaveType.findFirst({ where: { id: BigInt(dto.leaveTypeId), isActive: true } });
      if (!employee) throw DomainError.notFound('Employee', dto.employeeId);
      if (!type) throw DomainError.notFound('LeaveType', dto.leaveTypeId);
      if (['ANNUAL', 'SICK'].includes(type.category) && startDate.getUTCFullYear() !== endDate.getUTCFullYear()) {
        throw new DomainError(ErrorCode.LEAVE_REQUEST_SPANS_YEAR, 'Annual and sick leave requests must stay within one calendar year');
      }
      if (startDate < employee.hireDate || (employee.leaveDate && endDate > employee.leaveDate)) {
        throw new DomainError(ErrorCode.VALIDATION, 'Leave dates must be within employment dates');
      }
      const hospitalised = dto.hospitalised ?? false;
      if (hospitalised && type.category !== 'SICK') {
        throw new DomainError(ErrorCode.VALIDATION, 'Hospitalisation applies only to sick leave');
      }
      const settings = await tx.payrollSettings.findFirst({
        where: { effectiveFrom: { lte: endDate } },
        orderBy: [{ effectiveFrom: 'desc' }],
      });
      if (!settings) throw new DomainError(ErrorCode.PAYROLL_SETTINGS_REQUIRED, 'No payroll settings for leave period');
      const holidays = await tx.publicHoliday.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { date: true },
      });
      const count = countLeaveDays({
        startDate,
        endDate,
        countBasis: type.countBasis,
        weeklyRestDays: weeklyRestDays(settings.weeklyRestDays),
        holidays: holidays.map((holiday) => holiday.date),
      });
      if (count.days.lte(0)) throw new DomainError(ErrorCode.VALIDATION, 'Leave request has no counted days');
      if (type.maxDaysPerRequest && count.days.gt(type.maxDaysPerRequest)) {
        throw new DomainError(ErrorCode.LEAVE_LIMIT_EXCEEDED, 'Leave request exceeds the per-request limit');
      }
      const overlap = await tx.leaveRequest.findFirst({
        where: {
          employeeId: employee.id,
          status: { in: ['SUBMITTED', 'APPROVED'] },
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        select: { id: true },
      });
      if (overlap) throw new DomainError(ErrorCode.LEAVE_REQUEST_OVERLAP, 'Leave request overlaps another active request');
      const createdBy = cls.get('userId');
      if (!createdBy) throw new DomainError(ErrorCode.FORBIDDEN, 'A signed-in user is required');
      const created = await tx.leaveRequest.create({
        data: {
          tenantId,
          companyId,
          employeeId: employee.id,
          leaveTypeId: type.id,
          startDate,
          endDate,
          days: count.days,
          calendarDays: count.calendarDays,
          hospitalised,
          notes: dto.notes ?? null,
          createdBy,
        },
        include: REQUEST_INCLUDE,
      });
      return serializeRequest(created);
    }, POSTING_TX_OPTIONS);
  }

  async approve(id: bigint) {
    this.assertApprove();
    const { cls, tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await this.lockCompany(tx, tenantId, companyId);
      await tx.$queryRaw`SELECT id FROM leave_requests WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const request = await this.findRequest(tx, id);
      if (!request) throw DomainError.notFound('LeaveRequest', id.toString());
      if (request.status !== 'SUBMITTED') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only submitted leave requests can be approved');
      if (
        request.employee.leaveDate
        && (
          request.leaveType.category === 'ANNUAL'
          || request.leaveType.category === 'UNPAID'
          || request.leaveType.payElementId
        )
      ) {
        const departureRun = await tx.payrollRun.findFirst({
          where: {
            companyId,
            period: yearMonth(request.employee.leaveDate),
            status: { in: ['POSTED', 'PAID'] },
            lines: { some: { employeeId: request.employeeId } },
          },
          select: { id: true },
        });
        if (departureRun) {
          throw new DomainError(ErrorCode.LEAVE_RUN_ALREADY_POSTED, 'The employee departure payroll run is already posted');
        }
      }
      if (request.leaveType.payElementId) {
        await this.assertNoPostedPayrollForPeriod(tx, request.startDate, request.endDate);
      }
      await this.validateApproval(tx, request);
      const requestNo = await allocateDocumentNo(tx, tenantId, companyId, 'LEAVE_REQUEST', request.startDate);
      const updated = await tx.leaveRequest.update({
        where: { id },
        data: { status: 'APPROVED', requestNo, approvedBy: cls.get('userId') ?? null, approvedAt: new Date() },
        include: REQUEST_INCLUDE,
      });
      await this.audit.log({
        action: 'payroll.leave.approve',
        entityType: 'leave_request',
        entityId: id,
        before: { status: request.status },
        after: { status: updated.status, requestNo },
      }, tx);
      return serializeRequest(updated);
    }, POSTING_TX_OPTIONS);
  }

  async reject(id: bigint) {
    this.assertApprove();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await this.lockCompany(tx, tenantId, companyId);
      const request = await this.findRequest(tx, id);
      if (!request) throw DomainError.notFound('LeaveRequest', id.toString());
      if (request.status !== 'SUBMITTED') throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only submitted leave requests can be rejected');
      const updated = await tx.leaveRequest.update({ where: { id }, data: { status: 'REJECTED' }, include: REQUEST_INCLUDE });
      await this.audit.log({
        action: 'payroll.leave.reject', entityType: 'leave_request', entityId: id,
        before: { status: request.status }, after: { status: updated.status },
      }, tx);
      return serializeRequest(updated);
    }, POSTING_TX_OPTIONS);
  }

  async cancel(id: bigint) {
    this.assertApprove();
    const { tenantId, companyId, db } = this.context();
    return db.$transaction(async (tx) => {
      await this.lockCompany(tx, tenantId, companyId);
      await tx.$queryRaw`SELECT id FROM leave_requests WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND id = ${id} FOR UPDATE`;
      const request = await this.findRequest(tx, id);
      if (!request) throw DomainError.notFound('LeaveRequest', id.toString());
      if (!['SUBMITTED', 'APPROVED'].includes(request.status)) {
        throw new DomainError(ErrorCode.INVALID_STATUS_TRANSITION, 'Only submitted or approved requests can be cancelled');
      }
      if (request.status === 'APPROVED') {
        await this.assertNoPostedPayrollForPeriod(tx, request.startDate, request.endDate);
      }
      const updated = await tx.leaveRequest.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: asDate(dateString(new Date())) },
        include: REQUEST_INCLUDE,
      });
      await this.audit.log({
        action: 'payroll.leave.cancel', entityType: 'leave_request', entityId: id,
        before: { status: request.status }, after: { status: updated.status },
      }, tx);
      return serializeRequest(updated);
    }, POSTING_TX_OPTIONS);
  }

  private async validateApproval(tx: Prisma.TransactionClient, request: LeaveRequestRecord) {
    const days = request.days;
    const year = request.startDate.getUTCFullYear();
    const { end } = yearBounds(year);
    if (request.leaveType.maxDaysPerRequest && days.gt(request.leaveType.maxDaysPerRequest)) {
      throw new DomainError(ErrorCode.LEAVE_LIMIT_EXCEEDED, 'Leave request exceeds the per-request limit');
    }
    if (request.leaveType.minServiceYears !== null && request.startDate < addYears(request.employee.hireDate, request.leaveType.minServiceYears)) {
      throw new DomainError(ErrorCode.LEAVE_LIMIT_EXCEEDED, 'Employee has not completed the required service');
    }
    if (request.leaveType.oncePerEmployment) {
      const prior = await tx.leaveRequest.findFirst({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          status: 'APPROVED',
          id: { not: request.id },
        },
        select: { id: true },
      });
      if (prior) throw new DomainError(ErrorCode.LEAVE_LIMIT_EXCEEDED, 'This leave type is limited to once per employment');
    }
    if (request.leaveType.category === 'ANNUAL') {
      const approved = await tx.leaveRequest.findMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          status: 'APPROVED',
          startDate: { lte: end },
        },
        select: { startDate: true, days: true },
      });
      const settingsRows = await tx.payrollSettings.findMany({
        where: { effectiveFrom: { lte: end } },
        orderBy: [{ effectiveFrom: 'asc' }],
      });
      const adjustments = await tx.leaveBalanceAdjustment.findMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year: { lte: year },
        },
        select: { year: true, days: true },
      });
      const adjustmentByYear = new Map<number, Decimal>();
      for (const row of adjustments) adjustmentByYear.set(row.year, (adjustmentByYear.get(row.year) ?? new Decimal(0)).plus(row.days));
      const startYear = request.employee.hireDate.getUTCFullYear();
      const entitlements = new Map<number, Decimal>();
      const taken = new Map<number, Decimal>();
      for (let balanceYear = startYear; balanceYear <= year; balanceYear++) {
        const yearEnd = yearBounds(balanceYear).end;
        const yearSettings = settingsRows.filter((setting) => setting.effectiveFrom <= yearEnd).at(-1);
        const entitlement = annualLeaveEntitlement({
          year: balanceYear,
          hireDate: request.employee.hireDate,
          leaveDate: request.employee.leaveDate,
          annualLeaveDays: yearSettings?.annualLeaveDays ?? '14',
          annualLeaveDaysSenior: yearSettings?.annualLeaveDaysSenior ?? '21',
          annualLeaveSeniorYears: yearSettings?.annualLeaveSeniorYears ?? 5,
          adjustments: adjustmentByYear.get(balanceYear) ?? 0,
        });
        entitlements.set(balanceYear, entitlement);
        const takenInYear = approved
          .filter((row) => row.startDate.getUTCFullYear() === balanceYear)
          .reduce((sum, row) => sum.plus(row.days), new Decimal(0));
        taken.set(balanceYear, takenInYear);
      }
      const currentSettings = settingsRows.filter((setting) => setting.effectiveFrom <= end).at(-1);
      const currentEntitlement = annualLeaveEntitlement({
        year,
        hireDate: request.employee.hireDate,
        leaveDate: request.employee.leaveDate,
        annualLeaveDays: currentSettings?.annualLeaveDays ?? '14',
        annualLeaveDaysSenior: currentSettings?.annualLeaveDaysSenior ?? '21',
        annualLeaveSeniorYears: currentSettings?.annualLeaveSeniorYears ?? 5,
      });
      const carry = carryIntoYear({ year, startYear, entitlements, taken });
      const available = availableLeaveBalance({
        carryInto: carry,
        entitlement: currentEntitlement,
        adjustments: adjustmentByYear.get(year) ?? 0,
        taken: taken.get(year) ?? 0,
      });
      if (days.gt(available)) {
        throw new DomainError(ErrorCode.LEAVE_BALANCE_INSUFFICIENT, 'Annual leave exceeds the available balance');
      }
      return;
    }
    const { start: yearStart, end: yearEnd } = yearBounds(year);
    const approved = await tx.leaveRequest.findMany({
      where: {
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        status: 'APPROVED',
        startDate: { lte: yearEnd },
        endDate: { gte: yearStart },
      },
      select: { startDate: true, endDate: true, days: true, hospitalised: true },
    });
    const totalTaken = approved.reduce((sum, row) => sum.plus(row.days), new Decimal(0));
    const adjustment = await tx.leaveBalanceAdjustment.aggregate({
      where: { employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year },
      _sum: { days: true },
    });
    if (request.leaveType.category === 'SICK') {
      const totalLimit = new Decimal(request.leaveType.maxDaysPerYear ?? 14)
        .plus(request.leaveType.hospitalExtraDays ?? 14);
      const nonHospitalised = approved
        .filter((row) => !row.hospitalised)
        .reduce((sum, row) => sum.plus(row.days), new Decimal(0));
      if (totalTaken.plus(days).gt(totalLimit.plus(adjustment._sum.days ?? 0)) ||
          (!request.hospitalised && nonHospitalised.plus(days).gt(new Decimal(request.leaveType.maxDaysPerYear ?? 14).plus(adjustment._sum.days ?? 0)))) {
        throw new DomainError(ErrorCode.LEAVE_LIMIT_EXCEEDED, 'Sick leave limits are exceeded');
      }
    } else if (request.leaveType.maxDaysPerYear) {
      const startYear = request.startDate.getUTCFullYear();
      const endYear = request.endDate.getUTCFullYear();
      const { start: rangeStart } = yearBounds(startYear);
      const { end: rangeEnd } = yearBounds(endYear);
      const approvedForYears = await tx.leaveRequest.findMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          status: 'APPROVED',
          startDate: { lte: rangeEnd },
          endDate: { gte: rangeStart },
        },
        select: { startDate: true, endDate: true },
      });
      const settingsRows = await tx.payrollSettings.findMany({
        where: { effectiveFrom: { lte: rangeEnd } },
        orderBy: [{ effectiveFrom: 'asc' }],
      });
      const holidays = await tx.publicHoliday.findMany({
        where: { date: { gte: rangeStart, lte: rangeEnd } },
        select: { date: true },
      });
      const adjustments = await tx.leaveBalanceAdjustment.findMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year: { gte: startYear, lte: endYear },
        },
        select: { year: true, days: true },
      });
      for (let balanceYear = startYear; balanceYear <= endYear; balanceYear++) {
        const { start: balanceStart, end: balanceEnd } = yearBounds(balanceYear);
        const settings = settingsRows.filter((row) => row.effectiveFrom <= balanceEnd).at(-1);
        const holidayDates = holidays
          .filter((holiday) => holiday.date >= balanceStart && holiday.date <= balanceEnd)
          .map((holiday) => holiday.date);
        const daysInYear = (startDate: Date, endDate: Date) => {
          const clippedStart = startDate > balanceStart ? startDate : balanceStart;
          const clippedEnd = endDate < balanceEnd ? endDate : balanceEnd;
          return clippedEnd < clippedStart ? new Decimal(0) : countLeaveDays({
            startDate: clippedStart,
            endDate: clippedEnd,
            countBasis: request.leaveType.countBasis,
            weeklyRestDays: (settings?.weeklyRestDays ?? '5').split(',').map(Number),
            holidays: holidayDates,
          }).days;
        };
        const approvedInYear = approvedForYears.reduce((sum, row) => sum.plus(daysInYear(row.startDate, row.endDate)), new Decimal(0));
        const requestInYear = daysInYear(request.startDate, request.endDate);
        const adjustmentInYear = adjustments
          .filter((row) => row.year === balanceYear)
          .reduce((sum, row) => sum.plus(row.days), new Decimal(0));
        if (approvedInYear.plus(requestInYear).gt(new Decimal(request.leaveType.maxDaysPerYear).plus(adjustmentInYear))) {
          throw new DomainError(ErrorCode.LEAVE_LIMIT_EXCEEDED, 'Annual leave-type limit is exceeded');
        }
      }
    }
  }

  private async assertNoPostedPayrollForPeriod(tx: Prisma.TransactionClient, startDate: Date, endDate: Date) {
    const postedRun = await tx.payrollRun.findFirst({
      where: {
        status: { in: ['POSTED', 'PAID'] },
        period: { gte: yearMonth(startDate), lte: yearMonth(endDate) },
      },
      select: { id: true },
    });
    if (postedRun) throw new DomainError(ErrorCode.LEAVE_RUN_ALREADY_POSTED, 'Payroll is already posted for a leave period');
  }

  async listBalances(query: LeaveBalanceQueryDto) {
    const { db } = this.context();
    const year = Number(query.year);
    const { start, end } = yearBounds(year);
    const employees = await db.employee.findMany({
      where: {
        hireDate: { lte: end },
        OR: [{ leaveDate: null }, { leaveDate: { gte: start } }],
        ...(query.employeeId ? { id: BigInt(query.employeeId) } : {}),
      },
      orderBy: [{ nameAr: 'asc' }],
    });
    const leaveTypes = await db.leaveType.findMany({ where: { isActive: true }, orderBy: [{ code: 'asc' }] });
    if (!employees.length || !leaveTypes.length) return [];
    const earliestHire = new Date(Math.min(...employees.map((employee) => employee.hireDate.getTime())));
    const [settings, requests, adjustments, holidays] = await Promise.all([
      db.payrollSettings.findMany({ where: { effectiveFrom: { lte: end } }, orderBy: [{ effectiveFrom: 'asc' }] }),
      db.leaveRequest.findMany({
        where: {
          employeeId: { in: employees.map((employee) => employee.id) },
          status: 'APPROVED',
          startDate: { gte: earliestHire, lte: end },
        },
        select: { employeeId: true, leaveTypeId: true, startDate: true, endDate: true, days: true },
      }),
      db.leaveBalanceAdjustment.findMany({
        where: {
          employeeId: { in: employees.map((employee) => employee.id) },
          year: { lte: year },
        },
        select: { employeeId: true, leaveTypeId: true, year: true, days: true },
      }),
      db.publicHoliday.findMany({
        where: { date: { gte: earliestHire, lte: end } },
        select: { date: true },
      }),
    ]);
    const result: Array<{
      employeeId: string; employeeName: string; employeeNameEn: string | null; leaveTypeId: string; leaveTypeCode: string;
      leaveTypeNameAr: string; leaveTypeNameEn: string | null; category: string; entitlement: string; carryInto: string;
      adjustments: string; taken: string; available: string;
    }> = [];
    for (const employee of employees) {
      for (const type of leaveTypes) {
        const typeAdjustments = adjustments.filter((row) => row.employeeId === employee.id && row.leaveTypeId === type.id);
        const currentAdjustment = typeAdjustments
          .filter((row) => row.year === year)
          .reduce((sum, row) => sum.plus(row.days), new Decimal(0));
        const typeRequests = requests.filter((row) => row.employeeId === employee.id && row.leaveTypeId === type.id);
        const taken = typeRequests.reduce((sum, row) => {
          if (type.category === 'ANNUAL' || type.category === 'SICK') {
            return row.startDate.getUTCFullYear() === year ? sum.plus(row.days) : sum;
          }
          const overlapStart = row.startDate > start ? row.startDate : start;
          const overlapEnd = row.endDate < end ? row.endDate : end;
          if (overlapEnd < overlapStart) return sum;
          const yearSettings = settings.filter((setting) => setting.effectiveFrom <= yearBounds(year).end).at(-1);
          return sum.plus(countLeaveDays({
            startDate: overlapStart,
            endDate: overlapEnd,
            countBasis: type.countBasis,
            weeklyRestDays: weeklyRestDays(yearSettings?.weeklyRestDays ?? '5'),
            holidays: holidays.map((holiday) => holiday.date),
          }).days);
        }, new Decimal(0));
        let entitlement: Decimal;
        let carry = new Decimal(0);
        if (type.category === 'ANNUAL') {
          const startYear = employee.hireDate.getUTCFullYear();
          const entitlements = new Map<number, Decimal>();
          const takenByYear = new Map<number, Decimal>();
          for (let balanceYear = startYear; balanceYear <= year; balanceYear++) {
            const yearEnd = yearBounds(balanceYear).end;
            const yearSettings = settings.filter((setting) => setting.effectiveFrom <= yearEnd).at(-1);
            const adjustment = typeAdjustments
              .filter((row) => row.year === balanceYear)
              .reduce((sum, row) => sum.plus(row.days), new Decimal(0));
            entitlements.set(balanceYear, annualLeaveEntitlement({
              year: balanceYear,
              hireDate: employee.hireDate,
              leaveDate: employee.leaveDate,
              annualLeaveDays: yearSettings?.annualLeaveDays ?? '14',
              annualLeaveDaysSenior: yearSettings?.annualLeaveDaysSenior ?? '21',
              annualLeaveSeniorYears: yearSettings?.annualLeaveSeniorYears ?? 5,
              adjustments: adjustment,
            }));
            takenByYear.set(balanceYear, typeRequests
              .filter((row) => row.startDate.getUTCFullYear() === balanceYear)
              .reduce((sum, row) => sum.plus(row.days), new Decimal(0)));
          }
          const currentSettings = settings.filter((setting) => setting.effectiveFrom <= end).at(-1);
          entitlement = annualLeaveEntitlement({
            year,
            hireDate: employee.hireDate,
            leaveDate: employee.leaveDate,
            annualLeaveDays: currentSettings?.annualLeaveDays ?? '14',
            annualLeaveDaysSenior: currentSettings?.annualLeaveDaysSenior ?? '21',
            annualLeaveSeniorYears: currentSettings?.annualLeaveSeniorYears ?? 5,
          });
          carry = carryIntoYear({ year, startYear, entitlements, taken: takenByYear });
        } else {
          entitlement = new Decimal(type.maxDaysPerYear ?? type.maxDaysPerRequest ?? 0)
            .plus(type.category === 'SICK' ? type.hospitalExtraDays ?? 0 : 0);
        }
        const available = availableLeaveBalance({
          carryInto: carry,
          entitlement,
          adjustments: currentAdjustment,
          taken,
        });
        result.push({
          employeeId: employee.id.toString(),
          employeeName: employee.nameAr,
          employeeNameEn: employee.nameEn,
          leaveTypeId: type.id.toString(),
          leaveTypeCode: type.code,
          leaveTypeNameAr: type.nameAr,
          leaveTypeNameEn: type.nameEn,
          category: type.category,
          entitlement: entitlement.toString(),
          carryInto: carry.toString(),
          adjustments: currentAdjustment.toString(),
          taken: taken.toString(),
          available: available.toString(),
        });
      }
    }
    return result;
  }

  async listAdjustments(query: LeaveAdjustmentsQueryDto) {
    const { db } = this.context();
    const rows = await db.leaveBalanceAdjustment.findMany({
      where: {
        ...(query.employeeId ? { employeeId: BigInt(query.employeeId) } : {}),
        ...(query.year ? { year: Number(query.year) } : {}),
      },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      employeeId: row.employeeId.toString(),
      leaveTypeId: row.leaveTypeId.toString(),
      year: row.year,
      days: row.days.toString(),
      reason: row.reason,
      createdBy: row.createdBy.toString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createAdjustment(dto: CreateLeaveAdjustmentDto) {
    this.assertManage();
    const { tenantId, companyId, cls, db } = this.context();
    const days = new Decimal(dto.days);
    if (days.isZero()) throw new DomainError(ErrorCode.VALIDATION, 'Leave adjustment must be non-zero');
    const employeeId = BigInt(dto.employeeId);
    const leaveTypeId = BigInt(dto.leaveTypeId);
    const createdBy = cls.get('userId');
    if (!createdBy) throw new DomainError(ErrorCode.FORBIDDEN, 'A signed-in user is required');
    return db.$transaction(async (tx) => {
      await this.lockCompany(tx, tenantId, companyId);
      if (!await tx.employee.findFirst({ where: { id: employeeId }, select: { id: true } })) {
        throw DomainError.notFound('Employee', dto.employeeId);
      }
      if (!await tx.leaveType.findFirst({ where: { id: leaveTypeId }, select: { id: true } })) {
        throw DomainError.notFound('LeaveType', dto.leaveTypeId);
      }
      const row = await tx.leaveBalanceAdjustment.create({
        data: {
          tenantId,
          companyId,
          employeeId,
          leaveTypeId,
          year: Number(dto.year),
          days,
          reason: dto.reason,
          createdBy,
        },
      });
      await this.audit.log({
        action: 'payroll.leave.adjust',
        entityType: 'leave_balance_adjustment',
        entityId: row.id,
        after: { employeeId: employeeId.toString(), leaveTypeId: leaveTypeId.toString(), year: row.year, days: row.days.toString(), reason: row.reason },
      }, tx);
      return {
        id: row.id.toString(),
        employeeId: row.employeeId.toString(),
        leaveTypeId: row.leaveTypeId.toString(),
        year: row.year,
        days: row.days.toString(),
        reason: row.reason,
        createdBy: row.createdBy.toString(),
        createdAt: row.createdAt.toISOString(),
      };
    }, POSTING_TX_OPTIONS);
  }
}
