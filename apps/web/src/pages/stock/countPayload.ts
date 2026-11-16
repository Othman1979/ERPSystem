import type {
  CreateStockCountDto,
  CreateStockCountDtoScope,
  ItemGroupDto,
  StockCountDetailDto,
  StockCountLineDto,
  UpdateCountLineDto,
} from '@erp/api-client';
import { ApiError } from '@erp/api-client';
import { toDecimal } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';

/**
 * A stored quantity as the input shows it: '5.000000' reads as '5', '0' stays '0'.
 * Null for a line that was never counted.
 */
export function qtyText(stored: string | null | undefined): string | null {
  const d = toDecimal(stored);
  return d ? d.toString() : null;
}

/** Query key of one count document (ADR-030). Lists use the `['stock-counts']` prefix. */
export const countDetailKey = (id: string) => ['stock-counts', 'detail', id] as const;

/** The sheet import limit (ADR-030 §11): the API refuses a larger file. */
export const SHEET_MAX_BYTES = 5 * 1024 * 1024;

export interface NewCountInput {
  countDate: string;
  warehouseId: string;
  description?: string;
  blind: boolean;
  scope: CreateStockCountDtoScope;
  itemGroupId?: string;
  itemIds?: string[];
  includeZero?: boolean;
}

/**
 * The POST body of a new count. Only the fields of the chosen scope are sent:
 * the group for GROUP, the items for ITEMS, and "include zero balances" for
 * WAREHOUSE alone.
 */
export function buildCreateCountPayload(input: NewCountInput): CreateStockCountDto {
  const payload: CreateStockCountDto = {
    countDate: input.countDate,
    warehouseId: input.warehouseId,
    blind: input.blind,
    scope: input.scope,
  };
  const description = input.description?.trim();
  if (description) payload.description = description;
  if (input.scope === 'WAREHOUSE') {
    if (input.includeZero) payload.includeZero = true;
  } else if (input.scope === 'GROUP') {
    if (input.itemGroupId) payload.itemGroupId = input.itemGroupId;
  } else {
    payload.itemIds = [...new Set(input.itemIds ?? [])];
  }
  return payload;
}

/**
 * The body that saves one line: the entered quantity and, when the counter
 * chose one, its unit. Without a unit the API reads the quantity as base
 * units, so the unit must travel with every save. A blank quantity clears the line.
 */
export function lineBody(qty: string | null, itemUnitId: string | null): UpdateCountLineDto {
  if (qty === null) return { countedQty: null };
  return itemUnitId ? { countedQty: qty, itemUnitId } : { countedQty: qty };
}

/** Why the signed-in member may not approve this count, or null when they may (ADR-030 §3). */
export type ApproveBlock = 'CREATOR' | 'COUNTER' | null;

export function approveBlock(
  detail: Pick<StockCountDetailDto, 'createdBy' | 'lines'>,
  me: { userId?: string; isOwner: boolean },
): ApproveBlock {
  // The owner always may. Without a known user the server decides alone.
  if (me.isOwner || !me.userId) return null;
  if (detail.createdBy === me.userId) return 'CREATOR';
  if (detail.lines.some((l) => l.countedBy === me.userId)) return 'COUNTER';
  return null;
}

/**
 * A blind count hides the book and difference: the API answers null for both
 * while the count is a draft (ADR-030 §6). Any null line means the columns stay hidden.
 */
export function bookHidden(lines: readonly Pick<StockCountLineDto, 'systemQty'>[]): boolean {
  return lines.some((l) => l.systemQty == null);
}

/** Counted and total lines, from the quantities on screen (null = not counted). */
export function countProgress(quantities: readonly (string | null)[]): { counted: number; total: number } {
  return { counted: quantities.filter((q) => q !== null).length, total: quantities.length };
}

export type DiffTone = 'shortage' | 'surplus' | 'even' | 'none';

/** Shortage (negative), surplus (positive) or even, for colouring a difference. */
export function diffTone(value: string | null | undefined): DiffTone {
  const d = toDecimal(value);
  if (!d) return 'none';
  if (d.isNegative() && !d.isZero()) return 'shortage';
  if (d.isPositive() && !d.isZero()) return 'surplus';
  return 'even';
}

export interface SheetRowError {
  row: number;
  reason: string;
}

/**
 * The row errors of a refused import: the API's `details.errors`, each
 * `{ row, reason }`. Anything else yields an empty list.
 */
export function sheetRowErrors(err: unknown): SheetRowError[] {
  if (!(err instanceof ApiError) || !err.details) return [];
  const raw = err.details.errors;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown): SheetRowError[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { row, reason } = entry as { row?: unknown; reason?: unknown };
    return typeof row === 'number' && typeof reason === 'string' ? [{ row, reason }] : [];
  });
}

/** "CODE: detail" split, so the code can be translated and the detail kept. */
export function splitReason(reason: string): { code: string; detail: string } {
  const at = reason.indexOf(':');
  if (at < 0) return { code: reason.trim(), detail: '' };
  return { code: reason.slice(0, at).trim(), detail: reason.slice(at + 1).trim() };
}

/** Client-side check of a chosen sheet: xlsx only, at most 5 MB. */
export function sheetFileProblem(file: { name: string; size: number }): 'TYPE' | 'SIZE' | null {
  if (!/\.xlsx$/i.test(file.name)) return 'TYPE';
  if (file.size > SHEET_MAX_BYTES) return 'SIZE';
  return null;
}

export interface GroupTreeNode {
  value: string;
  title: string;
  children?: GroupTreeNode[];
}

/**
 * The active item groups as a tree for a tree select. A group whose parent is
 * missing or inactive sits at the top level.
 */
export function groupTreeData(groups: readonly ItemGroupDto[]): GroupTreeNode[] {
  const active = groups.filter((g) => g.isActive);
  const ids = new Set(active.map((g) => g.id));
  const childrenOf = new Map<string | null, ItemGroupDto[]>();
  for (const g of active) {
    const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), g]);
  }
  const build = (parent: string | null): GroupTreeNode[] =>
    (childrenOf.get(parent) ?? []).map((g) => {
      const children = build(g.id);
      return children.length
        ? { value: g.id, title: codeAndName(g), children }
        : { value: g.id, title: codeAndName(g) };
    });
  return build(null);
}

/** The document with one line replaced, or added when it is not on the sheet yet. */
export function withLine(detail: StockCountDetailDto, line: StockCountLineDto): StockCountDetailDto {
  const exists = detail.lines.some((l) => l.id === line.id);
  return {
    ...detail,
    lines: exists ? detail.lines.map((l) => (l.id === line.id ? line : l)) : [...detail.lines, line],
  };
}
