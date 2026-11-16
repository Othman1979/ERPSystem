import { describe, expect, it } from 'vitest';
import { ApiError } from '@erp/api-client';
import type { ItemGroupDto, StockCountDetailDto, StockCountLineDto } from '@erp/api-client';
import i18n from '../../i18n';
import {
  SHEET_MAX_BYTES,
  approveBlock,
  bookHidden,
  buildCreateCountPayload,
  countDetailKey,
  countProgress,
  diffTone,
  groupTreeData,
  lineBody,
  qtyText,
  sheetFileProblem,
  sheetRowErrors,
  splitReason,
  withLine,
} from './countPayload';
import { importReasonText } from './CountImportErrors';

const base = { countDate: '2026-11-10', warehouseId: '5', blind: false };

describe('buildCreateCountPayload (ADR-030 §1, §7)', () => {
  it('sends includeZero only for a whole-warehouse count', () => {
    const payload = buildCreateCountPayload({ ...base, scope: 'WAREHOUSE', includeZero: true, itemGroupId: '3', itemIds: ['1'] });
    expect(payload).toEqual({ ...base, scope: 'WAREHOUSE', includeZero: true });
  });

  it('leaves out includeZero when it is off', () => {
    const payload = buildCreateCountPayload({ ...base, scope: 'WAREHOUSE', includeZero: false });
    expect(payload).not.toHaveProperty('includeZero');
  });

  it('sends the group for a group count and nothing of the other scopes', () => {
    const payload = buildCreateCountPayload({ ...base, scope: 'GROUP', itemGroupId: '3', includeZero: true, itemIds: ['1'] });
    expect(payload).toEqual({ ...base, scope: 'GROUP', itemGroupId: '3' });
  });

  it('sends the chosen items once each for an items count', () => {
    const payload = buildCreateCountPayload({ ...base, scope: 'ITEMS', itemIds: ['11', '12', '11'], includeZero: true });
    expect(payload).toEqual({ ...base, scope: 'ITEMS', itemIds: ['11', '12'] });
  });

  it('trims the description and drops a blank one', () => {
    expect(buildCreateCountPayload({ ...base, scope: 'WAREHOUSE', description: '  May count  ' }).description).toBe('May count');
    expect(buildCreateCountPayload({ ...base, scope: 'WAREHOUSE', description: '   ' })).not.toHaveProperty('description');
  });

  it('carries the blind switch as given', () => {
    expect(buildCreateCountPayload({ ...base, blind: true, scope: 'WAREHOUSE' }).blind).toBe(true);
  });
});

describe('lineBody (ADR-030 §8)', () => {
  it('sends the quantity with its unit so the API does not read it as base units', () => {
    expect(lineBody('5', '42')).toEqual({ countedQty: '5', itemUnitId: '42' });
  });

  it('omits the unit for the base unit', () => {
    expect(lineBody('5', null)).toEqual({ countedQty: '5' });
    expect(lineBody('5', null)).not.toHaveProperty('itemUnitId');
  });

  it('clears the line with a null quantity', () => {
    expect(lineBody(null, '42')).toEqual({ countedQty: null });
  });

  it('keeps an explicit zero', () => {
    expect(lineBody('0', null)).toEqual({ countedQty: '0' });
  });
});

describe('qtyText', () => {
  it('shows a stored quantity without its trailing zeros, keeping an explicit zero', () => {
    expect(qtyText('5.000000')).toBe('5');
    expect(qtyText('1.250000')).toBe('1.25');
    expect(qtyText('0.000000')).toBe('0');
    expect(qtyText('0.000001')).toBe('0.000001');
    expect(qtyText(null)).toBeNull();
  });
});

describe('approveBlock (ADR-030 §3)', () => {
  const lines = [
    { countedBy: '8' },
    { countedBy: null },
  ] as unknown as StockCountLineDto[];

  it('never blocks the owner', () => {
    expect(approveBlock({ createdBy: '7', lines }, { userId: '7', isOwner: true })).toBeNull();
  });

  it('blocks the member who created the count', () => {
    expect(approveBlock({ createdBy: '7', lines: [] }, { userId: '7', isOwner: false })).toBe('CREATOR');
  });

  it('blocks a member who counted a line', () => {
    expect(approveBlock({ createdBy: '1', lines }, { userId: '8', isOwner: false })).toBe('COUNTER');
  });

  it('allows another member who neither created nor counted', () => {
    expect(approveBlock({ createdBy: '1', lines }, { userId: '9', isOwner: false })).toBeNull();
  });

  it('leaves the decision to the server when the user is not known', () => {
    expect(approveBlock({ createdBy: '1', lines }, { isOwner: false })).toBeNull();
  });
});

describe('bookHidden (ADR-030 §6)', () => {
  it('hides the book while any line has no book quantity', () => {
    expect(bookHidden([{ systemQty: null }, { systemQty: null }])).toBe(true);
  });

  it('shows the book when every line carries one', () => {
    expect(bookHidden([{ systemQty: '4.000000' }, { systemQty: '0' }])).toBe(false);
  });

  it('has nothing to hide on an empty sheet', () => {
    expect(bookHidden([])).toBe(false);
  });
});

describe('diffTone', () => {
  it('reads the sign of a difference', () => {
    expect(diffTone('-2.5')).toBe('shortage');
    expect(diffTone('3')).toBe('surplus');
    expect(diffTone('0.000')).toBe('even');
    expect(diffTone(null)).toBe('none');
  });
});

describe('countProgress', () => {
  it('counts the lines that have a quantity, an explicit zero included', () => {
    expect(countProgress(['0', null, '5', null])).toEqual({ counted: 2, total: 4 });
  });
});

describe('sheetRowErrors (ADR-030 §11)', () => {
  it('reads the row errors of a refused import', () => {
    const err = new ApiError(400, 'VALIDATION', 'The sheet has 2 problem(s)', {
      errors: [
        { row: 3, reason: 'UNKNOWN_ITEM: no active stock item' },
        { row: 7, reason: 'INVALID_QTY: the counted quantity must be a number' },
      ],
    });
    expect(sheetRowErrors(err)).toEqual([
      { row: 3, reason: 'UNKNOWN_ITEM: no active stock item' },
      { row: 7, reason: 'INVALID_QTY: the counted quantity must be a number' },
    ]);
  });

  it('ignores malformed entries and other errors', () => {
    const err = new ApiError(400, 'VALIDATION', 'x', { errors: [{ row: '3', reason: 'x' }, null, { row: 4, reason: 'DUPLICATE: y' }] });
    expect(sheetRowErrors(err)).toEqual([{ row: 4, reason: 'DUPLICATE: y' }]);
    expect(sheetRowErrors(new ApiError(404, 'NOT_FOUND', 'x'))).toEqual([]);
    expect(sheetRowErrors(new Error('network'))).toEqual([]);
  });
});

describe('splitReason and importReasonText', () => {
  it('splits the code from the detail', () => {
    expect(splitReason('UNKNOWN_UNIT: kg is not a unit of this item')).toEqual({
      code: 'UNKNOWN_UNIT',
      detail: 'kg is not a unit of this item',
    });
  });

  it('translates the code and keeps the detail', () => {
    expect(importReasonText(i18n.getFixedT('en'), 'DUPLICATE: the same item is on row 2')).toBe(
      'The item appears twice in the sheet (the same item is on row 2)',
    );
  });

  it('falls back to the raw reason for an unknown code', () => {
    expect(importReasonText(i18n.getFixedT('en'), 'SOMETHING_NEW: x')).toBe('SOMETHING_NEW (x)');
  });
});

describe('sheetFileProblem', () => {
  it('accepts an xlsx up to the limit, whatever the case of the extension', () => {
    expect(sheetFileProblem({ name: 'count.XLSX', size: 1024 })).toBeNull();
    expect(sheetFileProblem({ name: 'count.xlsx', size: SHEET_MAX_BYTES })).toBeNull();
  });

  it('refuses other types and larger files', () => {
    expect(sheetFileProblem({ name: 'count.csv', size: 10 })).toBe('TYPE');
    expect(sheetFileProblem({ name: 'count.xlsx.exe', size: 10 })).toBe('TYPE');
    expect(sheetFileProblem({ name: 'count.xlsx', size: SHEET_MAX_BYTES + 1 })).toBe('SIZE');
  });
});

describe('groupTreeData (ADR-030 §7)', () => {
  const group = (over: Partial<ItemGroupDto>): ItemGroupDto =>
    ({
      id: '1',
      tenantId: '1',
      code: 'G',
      nameAr: 'مجموعة',
      nameEn: null,
      parentId: null,
      isActive: true,
      createdAt: '',
      updatedAt: '',
      ...over,
    }) as ItemGroupDto;

  it('nests subgroups under their group and skips inactive ones', () => {
    const tree = groupTreeData([
      group({ id: '1', code: 'FOOD' }),
      group({ id: '2', code: 'DAIRY', parentId: '1' }),
      group({ id: '3', code: 'CHEESE', parentId: '2' }),
      group({ id: '4', code: 'OLD', isActive: false }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].value).toBe('1');
    expect(tree[0].children?.[0].value).toBe('2');
    expect(tree[0].children?.[0].children?.[0].value).toBe('3');
  });

  it('puts a group with a missing parent at the top level', () => {
    const tree = groupTreeData([group({ id: '5', code: 'ORPHAN', parentId: '99' })]);
    expect(tree.map((n) => n.value)).toEqual(['5']);
  });
});

describe('withLine and countDetailKey', () => {
  const line = (id: string, qty: string | null) => ({ id, countedUnitQty: qty }) as unknown as StockCountLineDto;
  const detail = { id: '9', lines: [line('1', null), line('2', null)] } as unknown as StockCountDetailDto;

  it('replaces a line by id', () => {
    const next = withLine(detail, line('2', '4'));
    expect(next.lines.map((l) => l.countedUnitQty)).toEqual([null, '4']);
    expect(detail.lines[1].countedUnitQty).toBeNull();
  });

  it('adds a line that is not on the sheet yet', () => {
    expect(withLine(detail, line('3', '1')).lines).toHaveLength(3);
  });

  it('keys the document by its id', () => {
    expect(countDetailKey('9')).toEqual(['stock-counts', 'detail', '9']);
  });
});
