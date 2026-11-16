import type { BomDetailDto, BomLineDto, CreateBomDto, UpdateBomDto } from '@erp/api-client';
import { dec, toDecimal } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';

/** A quantity as the API takes it: up to 12 digits and 6 decimals (ADR-031 §10). */
export const QTY_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
/** An amount as the API takes it: 3 decimals (the applied cost per unit). */
export const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,3})?$/;
/** Waste in percent: 0 to 100, checked here as well as on the server. */
export const MAX_WASTE = 100;

/** One component line of the editor. Quantities stay strings (CLAUDE.md money rules). */
export interface BomLineForm {
  key: number;
  componentItemId?: string;
  /** The component's label, kept so a chosen row stays named after the next search. */
  componentLabel?: string;
  /** Absent: the component's base unit. */
  itemUnitId?: string;
  qty?: string | null;
  wastePct?: string | null;
  note?: string;
}

/** The BOM editor's values. The item is fixed once the draft exists (the API ignores it on update). */
export interface BomForm {
  itemId?: string;
  outputQty?: string | null;
  /** Absent: the item's base unit. */
  outputItemUnitId?: string;
  appliedCostPerUnit?: string | null;
  note?: string;
  lines: BomLineForm[];
}

/** What is wrong with a BOM form; the editor marks each one. */
export type BomProblem = 'item' | 'outputQty' | 'lines' | 'component' | 'qty' | 'waste' | 'cost';

/** True for a quantity that is above zero and fits the API's pattern. */
export function isPositiveQty(value: string | null | undefined): boolean {
  if (value == null || !QTY_PATTERN.test(value)) return false;
  return dec(value).gt(0);
}

/** A line that names a component and a quantity; a half-filled row is not sent. */
export function isCompleteBomLine(line: BomLineForm): boolean {
  return !!line.componentItemId && isPositiveQty(line.qty);
}

/** The problems of a BOM form, each listed once; empty when the form may be sent. */
export function bomProblems(form: BomForm): BomProblem[] {
  const problems = new Set<BomProblem>();
  if (!form.itemId) problems.add('item');
  if (!isPositiveQty(form.outputQty)) problems.add('outputQty');
  if (form.appliedCostPerUnit && !AMOUNT_PATTERN.test(form.appliedCostPerUnit)) problems.add('cost');
  if (!form.lines.some(isCompleteBomLine)) problems.add('lines');
  for (const line of form.lines) {
    const started = !!line.componentItemId || !!line.qty;
    if (!started) continue;
    if (!line.componentItemId) problems.add('component');
    if (!isPositiveQty(line.qty)) problems.add('qty');
    const waste = toDecimal(line.wastePct);
    if (line.wastePct && (!waste || waste.lt(0) || waste.gt(MAX_WASTE))) problems.add('waste');
  }
  return [...problems];
}

/** The API body of one line: blank waste and note are left out, the unit is absent for the base unit. */
function lineBody(line: BomLineForm): BomLineDto {
  return {
    componentItemId: line.componentItemId!,
    ...(line.itemUnitId ? { itemUnitId: line.itemUnitId } : {}),
    qty: line.qty!.trim(),
    ...(line.wastePct ? { wastePct: line.wastePct.trim() } : {}),
    ...(line.note?.trim() ? { note: line.note.trim() } : {}),
  };
}

/** The shared part of the create and update bodies. Assumes bomProblems is empty. */
function commonBody(form: BomForm) {
  return {
    outputQty: form.outputQty!.trim(),
    ...(form.outputItemUnitId ? { outputItemUnitId: form.outputItemUnitId } : {}),
    ...(form.appliedCostPerUnit ? { appliedCostPerUnit: form.appliedCostPerUnit.trim() } : {}),
    ...(form.note?.trim() ? { note: form.note.trim() } : {}),
    lines: form.lines.filter(isCompleteBomLine).map(lineBody),
  };
}

/** POST /boms body. Only complete lines are sent: a half-filled row is not a component yet. */
export function bomCreateBody(form: BomForm): CreateBomDto {
  return { itemId: form.itemId!, ...commonBody(form) };
}

/** PUT /boms/:id body: the whole draft, without the item. */
export function bomUpdateBody(form: BomForm): UpdateBomDto {
  return commonBody(form);
}

/** The editor's starting values from a saved version (a draft, or a copy of one). */
export function bomFormFromDetail(bom: BomDetailDto, nextKey: () => number): BomForm {
  return {
    itemId: bom.itemId,
    outputQty: bom.outputQty,
    outputItemUnitId: bom.outputItemUnitId ?? undefined,
    appliedCostPerUnit: bom.appliedCostPerUnit,
    note: bom.note ?? '',
    lines: bom.lines.map((l) => ({
      key: nextKey(),
      componentItemId: l.componentItemId,
      componentLabel: codeAndName(l.componentItem),
      itemUnitId: l.itemUnit?.id,
      qty: l.qty,
      wastePct: l.wastePct,
      note: l.note ?? '',
    })),
  };
}
