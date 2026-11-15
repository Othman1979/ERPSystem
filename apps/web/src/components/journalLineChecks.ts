import type { TFunction } from 'i18next';
import type { AccountDto, AccountMappingSlotDto } from '@erp/api-client';
import { round3, toDecimal } from '../format/number';

/** Party side a journal line carries (journal_lines.party_type). */
export type PartyKind = 'CUSTOMER' | 'SUPPLIER';

/**
 * The party a line on an account needs: a customer, a supplier, or a party of
 * either side ('ANY', a control account without a customers/suppliers type).
 * An account missing from the map takes no party.
 */
export type PartyNeed = PartyKind | 'ANY';

/** The party kind a customers / suppliers control type requires, if any. */
export function partyKindOf(controlType: string | null | undefined): PartyKind | undefined {
  if (controlType === 'CUSTOMERS') return 'CUSTOMER';
  if (controlType === 'SUPPLIERS') return 'SUPPLIER';
  return undefined;
}

type AccountFlags = Pick<AccountDto, 'id' | 'isControl' | 'controlType'>;
type MappingSlot = Pick<AccountMappingSlotDto, 'mappingKey' | 'accountId'>;

/**
 * Which accounts need a party, and of which kind: the client copy of decision
 * D-2 in PostingService.validateLines (the API stays the authority).
 *  - A control account (isControl, or a CUSTOMERS / SUPPLIERS control type)
 *    needs a party; its control type fixes the kind, otherwise either kind.
 *  - Failing that, the account mapped as CUSTOMERS_CONTROL / SUPPLIERS_CONTROL
 *    (a legacy chart without control flags) needs a party of the mapping's kind.
 */
export function partyNeedByAccount(
  accounts: readonly AccountFlags[] | undefined,
  mappings: readonly MappingSlot[] | undefined,
): Map<string, PartyNeed> {
  const legacy = new Map<string, PartyKind>();
  for (const m of mappings ?? []) {
    if (!m.accountId) continue;
    if (m.mappingKey === 'CUSTOMERS_CONTROL') legacy.set(m.accountId, 'CUSTOMER');
    else if (m.mappingKey === 'SUPPLIERS_CONTROL') legacy.set(m.accountId, 'SUPPLIER');
  }
  const needs = new Map<string, PartyNeed>();
  for (const a of accounts ?? []) {
    const kind = partyKindOf(a.controlType);
    if (a.isControl || kind) needs.set(a.id, kind ?? 'ANY');
    else {
      const mapped = legacy.get(a.id);
      if (mapped) needs.set(a.id, mapped);
    }
  }
  return needs;
}

/** The side a party of this type takes on a control account of no side: a BOTH party counts as a customer. */
export function sideOfPartyType(partyType: 'CUSTOMER' | 'SUPPLIER' | 'BOTH'): PartyKind {
  return partyType === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER';
}

/**
 * partyType / partyId a line sends, or undefined when it sends no party: no
 * party chosen, or (on an 'ANY' account) a party whose side is not known.
 * The check before saving and the request both use this, so a line the check
 * accepts always carries its party.
 */
export function lineParty(
  need: PartyNeed,
  partyId: string | null | undefined,
  sideOf?: (partyId: string) => PartyKind | undefined,
): { partyType: PartyKind; partyId: string } | undefined {
  if (!partyId) return undefined;
  const partyType = need === 'ANY' ? sideOf?.(partyId) : need;
  return partyType ? { partyType, partyId } : undefined;
}

/**
 * Cost centre rules of the chart (ADR-024 §1), as the client copy of
 * PostingService.validateLines: the income-statement accounts (a centre is
 * allowed on them only) and those of them flagged costCenterRequired.
 */
export interface CostCenterSets {
  income: ReadonlySet<string>;
  required: ReadonlySet<string>;
}

/** The centre rules of a company: `enabled` is companies.cost_centers_enabled. */
export interface CostCenterRules extends CostCenterSets {
  enabled: boolean;
}

type CostCenterFlags = { id: string; accountType: string; costCenterRequired?: boolean };

/**
 * Income-statement accounts (REVENUE, EXPENSE) and the ones among them that
 * require a centre, from the chart. Without accounts (still loading) both sets are empty.
 */
export function costCenterRulesByAccount(accounts: readonly CostCenterFlags[] | undefined): CostCenterSets {
  const income = new Set<string>();
  const required = new Set<string>();
  for (const a of accounts ?? []) {
    if (a.accountType !== 'REVENUE' && a.accountType !== 'EXPENSE') continue;
    income.add(a.id);
    if (a.costCenterRequired) required.add(a.id);
  }
  return { income, required };
}

export interface CheckedLine {
  accountId?: string;
  debit?: string | null;
  credit?: string | null;
  partyId?: string | null;
  costCenterId?: string | null;
}

export type LineRule = 'ONE_SIDE' | 'PARTY_REQUIRED' | 'COST_CENTER_NOT_ALLOWED' | 'COST_CENTER_REQUIRED';

export interface LineProblem {
  /** Row number as shown in the grid (1-based; rows without an account count too). */
  line: number;
  /** Index of the row in the lines given. */
  index: number;
  rule: LineRule;
  /** The party the row needs (PARTY_REQUIRED only). */
  need?: PartyNeed;
}

/** Same test as PostingService: an amount counts once it rounds above 0.000. */
const positive = (v?: string | null) => {
  const d = toDecimal(v);
  return !!d && round3(d).gt(0);
};

/**
 * The first row the API would refuse to post, in the API's order: debit XOR
 * credit, then the party, then the cost centre (ADR-024 §1). Checked before
 * saving, because a saved draft cannot be edited: a row the API rejects at
 * posting means deleting the draft. Rows without an account are skipped (they
 * are not sent). `sideOf` as in PartyColumn: a party on an 'ANY' account counts
 * only once its side is known. `centres` (omitted: no centre checks) gives the
 * centre rules; the required rule applies only while the company has centres on.
 */
export function firstLineProblem(
  lines: readonly CheckedLine[],
  needByAccount: ReadonlyMap<string, PartyNeed>,
  sideOf?: (partyId: string) => PartyKind | undefined,
  centres?: CostCenterRules,
): LineProblem | null {
  for (const [index, l] of lines.entries()) {
    if (!l.accountId) continue;
    const base = { line: index + 1, index };
    if (positive(l.debit) === positive(l.credit)) return { ...base, rule: 'ONE_SIDE' };
    const need = needByAccount.get(l.accountId);
    if (need && !lineParty(need, l.partyId, sideOf)) return { ...base, rule: 'PARTY_REQUIRED', need };
    if (centres) {
      if (l.costCenterId && !centres.income.has(l.accountId)) return { ...base, rule: 'COST_CENTER_NOT_ALLOWED' };
      if (centres.enabled && centres.required.has(l.accountId) && !l.costCenterId) {
        return { ...base, rule: 'COST_CENTER_REQUIRED' };
      }
    }
  }
  return null;
}

/** The message for a row the check before saving refused. */
export function lineProblemText(t: TFunction, p: LineProblem): string {
  if (p.rule === 'ONE_SIDE') return t('journal.oneSide', { line: p.line });
  if (p.rule === 'COST_CENTER_NOT_ALLOWED') return t('costCenters.lineNotAllowed', { line: p.line });
  if (p.rule === 'COST_CENTER_REQUIRED') return t('costCenters.lineRequired', { line: p.line });
  if (p.need === 'CUSTOMER') return t('journal.partyRequiredCustomer', { line: p.line });
  if (p.need === 'SUPPLIER') return t('journal.partyRequiredSupplier', { line: p.line });
  return t('journal.partyRequired', { line: p.line });
}
