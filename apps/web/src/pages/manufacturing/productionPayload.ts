import type { CreateProductionVoucherDto, UpdateProductionVoucherDto } from '@erp/api-client';
import Decimal from 'decimal.js';
import { dec, round3, round6, toDecimal } from '../../format/number';
import { isPositiveQty } from './bomPayload';

/** One consumption line of the voucher. `qty` is the actual quantity in `itemUnitId` (or the base unit). */
export interface ProductionLineForm {
  key: number;
  itemId?: string;
  /** The material's label, kept after the next search. */
  itemLabel?: string;
  itemUnitId?: string;
  qty?: string | null;
  /** The formula's quantity in the base unit; zero for a material the formula does not have. */
  standardQtyBase?: string | null;
  /** The user changed this line, so a formula or quantity change keeps its quantity. */
  edited?: boolean;
  note?: string;
}

export interface ProductionForm {
  itemId?: string;
  bomId?: string;
  qty?: string | null;
  itemUnitId?: string;
  materialsWarehouseId?: string;
  outputWarehouseId?: string;
  voucherDate: string;
  costCenterId?: string;
  description?: string;
  lines: ProductionLineForm[];
}

export type ProductionProblem = 'item' | 'bom' | 'qty' | 'materialsWarehouse' | 'lines' | 'line';

/** The problems of a voucher form, each listed once; empty when it may be saved. */
export function productionProblems(form: ProductionForm): ProductionProblem[] {
  const problems = new Set<ProductionProblem>();
  if (!form.itemId) problems.add('item');
  if (!form.bomId) problems.add('bom');
  if (!isPositiveQty(form.qty)) problems.add('qty');
  if (!form.materialsWarehouseId) problems.add('materialsWarehouse');
  if (!form.lines.some((l) => l.itemId && isPositiveQty(l.qty))) problems.add('lines');
  if (form.lines.some((l) => (l.itemId || l.qty) && !(l.itemId && isPositiveQty(l.qty)))) problems.add('line');
  return [...problems];
}

/** The lines that are sent: a material with an item and a positive quantity. */
function linesBody(lines: readonly ProductionLineForm[]) {
  return lines
    .filter((l) => l.itemId && isPositiveQty(l.qty))
    .map((l) => ({
      itemId: l.itemId!,
      ...(l.itemUnitId ? { itemUnitId: l.itemUnitId } : {}),
      qty: l.qty!.trim(),
      ...(l.note?.trim() ? { note: l.note.trim() } : {}),
    }));
}

/** The shared part of the create and update bodies. Assumes productionProblems is empty. */
function commonBody(form: ProductionForm) {
  return {
    bomId: form.bomId!,
    qty: form.qty!.trim(),
    ...(form.itemUnitId ? { itemUnitId: form.itemUnitId } : {}),
    materialsWarehouseId: form.materialsWarehouseId!,
    ...(form.outputWarehouseId ? { outputWarehouseId: form.outputWarehouseId } : {}),
    voucherDate: form.voucherDate,
    ...(form.costCenterId ? { costCenterId: form.costCenterId } : {}),
    ...(form.description?.trim() ? { description: form.description.trim() } : {}),
    lines: linesBody(form.lines),
  };
}

/** POST /production-vouchers body. The totals are never sent: the server computes them at posting. */
export function productionCreateBody(form: ProductionForm): CreateProductionVoucherDto {
  return { itemId: form.itemId!, ...commonBody(form) };
}

/** PUT /production-vouchers/:id body: the whole draft, without the product. */
export function productionUpdateBody(form: ProductionForm): UpdateProductionVoucherDto {
  return commonBody(form);
}

/**
 * A formula line's standard in the base unit for a produced quantity:
 * qtyBase x produced / output x (1 + waste %), 6 dp (ADR-031 §5).
 */
export function standardQtyBase(lineQtyBase: string, producedBase: string, outputQtyBase: string, wastePct: string): Decimal {
  const output = dec(outputQtyBase);
  if (output.lte(0)) return new Decimal(0);
  const scaled = dec(lineQtyBase).times(dec(producedBase)).div(output);
  return round6(scaled.times(new Decimal(1).plus(dec(wastePct).div(100))));
}

/** A unit's factor to the base unit; the base unit (no unit id) is 1, an unknown unit is null. */
export function unitFactor(
  itemUnitId: string | undefined,
  units: readonly { id: string; factorToBase: string }[] | undefined,
): Decimal | null {
  if (!itemUnitId) return new Decimal(1);
  const unit = units?.find((u) => u.id === itemUnitId);
  return unit ? toDecimal(unit.factorToBase) : null;
}

export type VarianceTone = 'even' | 'over' | 'under';

/** An actual line against its standard, both in the base unit (ADR-031 §3). */
export interface LineVariance {
  actualBase: Decimal | null;
  diffBase: Decimal | null;
  tone: VarianceTone;
}

/**
 * Standard against actual of one line. `actualQty` is in the line's unit, so it
 * is converted with `factorToBase` first. A missing standard counts as zero (an
 * extra material). Without a usable quantity or factor there is no difference.
 */
export function varianceOf(
  standardBase: string | null | undefined,
  actualQty: string | null | undefined,
  factorToBase: string | null | undefined,
): LineVariance {
  const factor = toDecimal(factorToBase);
  const actual = toDecimal(actualQty);
  if (!actual || !factor) return { actualBase: null, diffBase: null, tone: 'even' };
  const actualBase = round6(actual.times(factor));
  const diffBase = actualBase.minus(dec(standardBase));
  const tone: VarianceTone = diffBase.gt(0) ? 'over' : diffBase.lt(0) ? 'under' : 'even';
  return { actualBase, diffBase, tone };
}

/** The formula's standard per component for a produced quantity in the base unit. */
export function standardByComponent(
  bomLines: readonly { componentItemId: string; qtyBase: string; wastePct: string }[],
  producedBase: string,
  outputQtyBase: string,
): Map<string, Decimal> {
  return new Map(
    bomLines.map((l) => [l.componentItemId, standardQtyBase(l.qtyBase, producedBase, outputQtyBase, l.wastePct)] as const),
  );
}

/**
 * The lines after a formula or quantity change. Each formula material takes its
 * standard in the base unit, unless the user edited it and `keepEdited` is set.
 * Materials the formula does not have stay, with a standard of zero. Formula
 * materials not yet on the form are added after the existing lines.
 */
export function withStandard(
  lines: readonly ProductionLineForm[],
  bomLines: readonly { componentItemId: string; componentLabel: string; qtyBase: string; wastePct: string }[],
  producedBase: string,
  outputQtyBase: string,
  nextKey: () => number,
  { keepEdited }: { keepEdited: boolean },
): ProductionLineForm[] {
  const standards = standardByComponent(bomLines, producedBase, outputQtyBase);
  const seen = new Set<string>();
  const updated = lines.map((line): ProductionLineForm => {
    const standard = line.itemId ? standards.get(line.itemId) : undefined;
    if (!line.itemId || standard === undefined) return { ...line, standardQtyBase: line.itemId ? '0' : line.standardQtyBase };
    seen.add(line.itemId);
    if (keepEdited && line.edited) return { ...line, standardQtyBase: standard.toFixed(6) };
    return { ...line, qty: standard.toFixed(6), itemUnitId: undefined, standardQtyBase: standard.toFixed(6), edited: false };
  });
  const added = bomLines
    .filter((l) => !seen.has(l.componentItemId))
    .map((l): ProductionLineForm => {
      const standard = standards.get(l.componentItemId)!.toFixed(6);
      return {
        key: nextKey(),
        itemId: l.componentItemId,
        itemLabel: l.componentLabel,
        qty: standard,
        standardQtyBase: standard,
        edited: false,
      };
    });
  return [...updated, ...added];
}

/**
 * The applied cost before posting: the version's cost per unit times the
 * produced base quantity, 3 dp (ADR-031 §2). The materials are priced only at posting.
 */
export function appliedCostPreview(
  appliedCostPerUnit: string | null | undefined,
  producedBase: string | null | undefined,
): Decimal | null {
  const cost = toDecimal(appliedCostPerUnit);
  const produced = toDecimal(producedBase);
  if (!cost || !produced) return null;
  return round3(cost.times(produced));
}
