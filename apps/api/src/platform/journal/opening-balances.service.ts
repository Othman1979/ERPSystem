import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal, round3, sum } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PartiesService } from '../parties/parties.service.js';
import type { SetAccountOpeningDto, SetPartyOpeningDto } from './dto/opening.dto.js';
import { PostingService, type JournalLineInput } from './posting.service.js';

const OPENING_SOURCE = 'OPENING_ENTRY';

type Db = ReturnType<PrismaService['forTenant']>;
type Tx = Prisma.TransactionClient;
type PartyType = 'CUSTOMER' | 'SUPPLIER';

/** Why an account's opening balance is not typed on the account itself. */
export type AccountLockReason =
  | 'GROUP_ACCOUNT'
  | 'INACTIVE_ACCOUNT'
  | 'INCOME_ACCOUNT'
  | 'CONTROL_ACCOUNT'
  | 'INVENTORY_ACCOUNT'
  | 'EQUITY_PLUG';

/** Why no opening balance can be saved right now, for anything. */
export type OpeningLockReason = 'NO_FISCAL_YEAR' | 'PERIOD_CLOSED' | 'NO_PERMISSION';

/** True when the caller holds `code` (same source as PermissionsGuard). */
export function callerCan(code: string): boolean {
  return ClsServiceManager.getClsService<RequestContext>().get('permissions')?.has(code) ?? false;
}

/** The general lock: no fiscal year, a closed first period, or no right to post. */
export function generalLock(ctx: OpeningContext | null, permission: string): OpeningLockReason | null {
  if (!ctx) return 'NO_FISCAL_YEAR';
  if (!ctx.editable) return 'PERIOD_CLOSED';
  if (!callerCan(permission)) return 'NO_PERMISSION';
  return null;
}

/** Where and when opening balances are posted: the company's first fiscal year. */
export interface OpeningContext {
  fiscalYearId: bigint;
  fiscalYearCode: string;
  /** First day of the first fiscal year. */
  date: Date;
  /** The period holding that day is open. */
  editable: boolean;
}

interface Mappings {
  equity: bigint;
  inventory: bigint | null;
  customers: bigint | null;
  suppliers: bigint | null;
}

const net = (debit: Decimal.Value, credit: Decimal.Value) => new Decimal(debit).minus(credit);
const sides = (n: Decimal) => ({
  debit: (n.gt(0) ? n : new Decimal(0)).toString(),
  credit: (n.lt(0) ? n.neg() : new Decimal(0)).toString(),
});

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  const msg = String((err as Error)?.message ?? '');
  return code === 'P2034' || /deadlock|lock wait timeout/i.test(msg);
}

/**
 * Opening balances entered on the account and the customer/supplier forms
 * (BUILD_PLAN §8.6, ADR-007). The user sets a target balance; each save posts
 * only the change as an opening entry against OPENING_BALANCE_EQUITY, dated
 * on the first day of the first fiscal year. Posted entries are never edited.
 */
@Injectable()
export class OpeningBalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly parties: PartiesService,
    private readonly audit: AuditService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: Db): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  private userId(): bigint | undefined {
    return ClsServiceManager.getClsService<RequestContext>().get('userId');
  }

  /**
   * The first fiscal year and whether its first period is still open. Null
   * when the company has no fiscal year yet. Shared with opening stock.
   */
  async openingContext(tx: Tx | Db, tenantId: bigint, companyId: bigint): Promise<OpeningContext | null> {
    const fy = await tx.fiscalYear.findFirst({
      where: { tenantId, companyId },
      orderBy: { startDate: 'asc' },
      select: { id: true, code: true, startDate: true },
    });
    if (!fy) return null;
    const period = await tx.fiscalPeriod.findFirst({
      where: { tenantId, fiscalYearId: fy.id, startDate: { lte: fy.startDate }, endDate: { gte: fy.startDate } },
      select: { status: true },
    });
    return {
      fiscalYearId: fy.id,
      fiscalYearCode: fy.code,
      date: fy.startDate,
      editable: period?.status === 'OPEN',
    };
  }

  private async requireContext(tx: Tx, tenantId: bigint, companyId: bigint): Promise<OpeningContext> {
    const ctx = await this.openingContext(tx, tenantId, companyId);
    if (!ctx) {
      throw new DomainError(ErrorCode.VALIDATION, 'Create a fiscal year before entering opening balances', {
        rule: 'NO_FISCAL_YEAR',
      });
    }
    return ctx;
  }

  private async mappings(tx: Tx | Db, tenantId: bigint, companyId: bigint): Promise<Mappings> {
    const rows = await tx.accountMapping.findMany({
      where: {
        tenantId,
        companyId,
        mappingKey: { in: ['OPENING_BALANCE_EQUITY', 'INVENTORY', 'CUSTOMERS_CONTROL', 'SUPPLIERS_CONTROL'] },
      },
      select: { mappingKey: true, accountId: true },
    });
    const by = new Map(rows.map((r) => [r.mappingKey, r.accountId]));
    const equity = by.get('OPENING_BALANCE_EQUITY');
    if (!equity) throw new DomainError(ErrorCode.INTERNAL, 'OPENING_BALANCE_EQUITY mapping missing');
    return {
      equity,
      inventory: by.get('INVENTORY') ?? null,
      customers: by.get('CUSTOMERS_CONTROL') ?? null,
      suppliers: by.get('SUPPLIERS_CONTROL') ?? null,
    };
  }

  /** Accounts whose opening balance comes from elsewhere, or cannot have one. */
  private lockReason(
    account: { id: bigint; isPostable: boolean; isActive: boolean; isControl: boolean; accountType: string },
    m: Mappings,
  ): AccountLockReason | null {
    if (!account.isPostable) return 'GROUP_ACCOUNT';
    if (account.id === m.equity) return 'EQUITY_PLUG';
    if (account.isControl || account.id === m.customers || account.id === m.suppliers) return 'CONTROL_ACCOUNT';
    if (account.id === m.inventory) return 'INVENTORY_ACCOUNT';
    // Revenue and expenses start every year at zero.
    if (account.accountType === 'REVENUE' || account.accountType === 'EXPENSE') return 'INCOME_ACCOUNT';
    if (!account.isActive) return 'INACTIVE_ACCOUNT';
    return null;
  }

  /** Net (debit − credit) of the opening lines matching `where`. */
  private async currentNet(tx: Tx | Db, where: Prisma.JournalLineWhereInput, companyId: bigint): Promise<Decimal> {
    const agg = await tx.journalLine.aggregate({
      where: { ...where, entry: { companyId, status: 'POSTED', isOpening: true } },
      _sum: { debit: true, credit: true },
    });
    return net(agg._sum.debit?.toString() ?? 0, agg._sum.credit?.toString() ?? 0);
  }

  /** One side or none; amounts at 3 places. */
  private target(dto: SetAccountOpeningDto): Decimal {
    const debit = round3(dto.debit ?? 0);
    const credit = round3(dto.credit ?? 0);
    if (debit.gt(0) && credit.gt(0)) {
      throw new DomainError(ErrorCode.VALIDATION, 'Enter the opening balance as a debit or a credit, not both', {
        rule: 'ONE_SIDE',
      });
    }
    return debit.minus(credit);
  }

  /** Posts the change from `current` to `target` on `line` against the equity plug. */
  private async postChange(
    tx: Tx,
    tenantId: bigint,
    companyId: bigint,
    ctx: OpeningContext,
    equity: bigint,
    line: Omit<JournalLineInput, 'debit' | 'credit'>,
    delta: Decimal,
    description: string,
  ) {
    const amount = delta.abs().toString();
    const lines: JournalLineInput[] = [
      { ...line, ...(delta.gt(0) ? { debit: amount } : { credit: amount }) },
      { accountId: equity, ...(delta.gt(0) ? { credit: amount } : { debit: amount }) },
    ];
    const period = await this.posting.resolveOpenPeriod(tx, tenantId, companyId, ctx.date);
    const entryNo = await this.posting.allocateEntryNo(tx, tenantId, companyId, 'OPENING_ENTRY', ctx.date);
    return this.posting.postEntry(tx, {
      tenantId,
      companyId,
      entryDate: ctx.date,
      fiscalPeriodId: period.id,
      entryNo,
      sourceType: OPENING_SOURCE,
      sourceId: null,
      description,
      lines,
      postedBy: this.userId() ?? null,
      isOpening: true,
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isRetryable(err)) return fn();
      throw err;
    }
  }

  // ------------------------------------------------------------- reads

  /** Opening position of every account, for the chart's summary strip. */
  async summary() {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const [ctx, m, grouped] = await Promise.all([
      this.openingContext(db, tenantId, companyId),
      this.mappings(db, tenantId, companyId),
      db.journalLine.groupBy({
        by: ['accountId'],
        where: { entry: { companyId, status: 'POSTED', isOpening: true } },
        _sum: { debit: true, credit: true },
      }),
    ]);
    const accounts = grouped
      .map((g) => ({ accountId: g.accountId, n: net(g._sum.debit?.toString() ?? 0, g._sum.credit?.toString() ?? 0) }))
      .filter((a) => !a.n.isZero());
    const others = accounts.filter((a) => a.accountId !== m.equity);
    const plug = accounts.find((a) => a.accountId === m.equity)?.n ?? new Decimal(0);
    // Lock for new records on the forms: accounts and parties, and items' opening stock.
    const lockedReason = generalLock(ctx, PERMISSIONS.JOURNAL_POST);
    return {
      date: ctx?.date ?? null,
      fiscalYearCode: ctx?.fiscalYearCode ?? null,
      editable: lockedReason === null,
      lockedReason,
      stockLockedReason: generalLock(ctx, PERMISSIONS.STOCK_MOVEMENT),
      equityAccountId: m.equity.toString(),
      inventoryAccountId: m.inventory?.toString() ?? null,
      accounts: accounts.map((a) => ({ accountId: a.accountId.toString(), ...sides(a.n) })),
      // Totals of everything except the plug; the plug holds the difference.
      totals: {
        debit: sum(others.map((a) => (a.n.gt(0) ? a.n : 0))).toString(),
        credit: sum(others.map((a) => (a.n.lt(0) ? a.n.neg() : 0))).toString(),
      },
      difference: sides(plug),
    };
  }

  /** One account's opening balance and whether it is entered on the account form. */
  async account(accountId: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const account = await db.account.findFirst({ where: { id: accountId, companyId } });
    if (!account) throw DomainError.notFound('Account', accountId.toString());
    const [ctx, m, current] = await Promise.all([
      this.openingContext(db, tenantId, companyId),
      this.mappings(db, tenantId, companyId),
      this.currentNet(db, { accountId }, companyId),
    ]);
    const lockedReason = this.lockReason(account, m) ?? generalLock(ctx, PERMISSIONS.JOURNAL_POST);
    return {
      accountId: accountId.toString(),
      ...sides(current),
      date: ctx?.date ?? null,
      editable: lockedReason === null,
      lockedReason,
    };
  }

  /** The customer and/or supplier opening balance of a party. */
  async party(partyId: bigint) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const party = await this.parties.get(partyId);
    const [ctx, m] = await Promise.all([
      this.openingContext(db, tenantId, companyId),
      this.mappings(db, tenantId, companyId),
    ]);
    const roles: PartyType[] =
      party.partyType === 'BOTH' ? ['CUSTOMER', 'SUPPLIER'] : [party.partyType as PartyType];
    const balances = await Promise.all(
      roles.map(async (partyType) => {
        const control = partyType === 'CUSTOMER' ? m.customers : m.suppliers;
        const current = control
          ? await this.currentNet(db, { accountId: control, partyType, partyId }, companyId)
          : new Decimal(0);
        return { partyType, accountId: control?.toString() ?? null, ...sides(current) };
      }),
    );
    const lockedReason = generalLock(ctx, PERMISSIONS.JOURNAL_POST);
    return {
      partyId: partyId.toString(),
      date: ctx?.date ?? null,
      editable: lockedReason === null,
      lockedReason,
      balances,
    };
  }

  // ------------------------------------------------------------ writes

  async setAccount(accountId: bigint, dto: SetAccountOpeningDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const target = this.target(dto);

    const posted = await this.withRetry(() =>
      db.$transaction(async (tx) => {
        // One writer per account; the lock MUST stay the first statement (see setParty).
        await tx.$queryRaw`SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND id = ${accountId} FOR UPDATE`;
        const account = await tx.account.findFirst({ where: { tenantId, companyId, id: accountId } });
        if (!account) throw DomainError.notFound('Account', accountId.toString());
        const m = await this.mappings(tx, tenantId, companyId);
        const reason = this.lockReason(account, m);
        if (reason) {
          throw new DomainError(
            ErrorCode.OPENING_BALANCE_LOCKED,
            `The opening balance of account ${account.code} is not entered on the account (${reason})`,
            { reason, accountCode: account.code },
          );
        }
        const ctx = await this.requireContext(tx, tenantId, companyId);
        const delta = target.minus(await this.currentNet(tx, { accountId }, companyId));
        if (delta.isZero()) return null;
        return this.postChange(tx, tenantId, companyId, ctx, m.equity, { accountId }, delta, `Opening balance ${account.code}`);
      }),
    );

    if (posted) {
      await this.audit.log({
        action: 'opening.account',
        entityType: 'account',
        entityId: accountId,
        after: { entryNo: posted.entryNo, balance: target.toString() },
      });
    }
    return this.account(accountId);
  }

  async setParty(partyId: bigint, dto: SetPartyOpeningDto) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const target = this.target(dto);
    const party = await this.parties.get(partyId);
    if (party.partyType !== 'BOTH' && party.partyType !== dto.partyType) {
      throw new DomainError(ErrorCode.VALIDATION, `Party ${party.code} is not a ${dto.partyType.toLowerCase()}`, {
        rule: 'PARTY_TYPE',
      });
    }

    const m = await this.mappings(db, tenantId, companyId);
    const control = dto.partyType === 'CUSTOMER' ? m.customers : m.suppliers;
    if (!control) {
      throw new DomainError(ErrorCode.INTERNAL, `${dto.partyType}S_CONTROL mapping missing`);
    }

    const posted = await this.withRetry(() =>
      db.$transaction(async (tx) => {
        // One writer per control account, and the lock MUST be the first statement:
        // under REPEATABLE READ an earlier plain read would fix a snapshot that
        // misses the other writer's lines, and post the change twice.
        await tx.$queryRaw`SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND id = ${control} FOR UPDATE`;
        const ctx = await this.requireContext(tx, tenantId, companyId);
        const where = { accountId: control, partyType: dto.partyType, partyId };
        const delta = target.minus(await this.currentNet(tx, where, companyId));
        if (delta.isZero()) return null;
        return this.postChange(
          tx,
          tenantId,
          companyId,
          ctx,
          m.equity,
          where,
          delta,
          `Opening balance ${party.code}`,
        );
      }),
    );

    if (posted) {
      await this.audit.log({
        action: 'opening.party',
        entityType: 'party',
        entityId: partyId,
        after: { entryNo: posted.entryNo, partyType: dto.partyType, balance: target.toString() },
      });
    }
    return this.party(partyId);
  }
}
