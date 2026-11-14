import type { CreateBranchDto, UpdateBranchDto } from '@erp/api-client';
import { describe, expect, it } from 'vitest';
import { branchCreateBody, branchUpdateBody, type BranchFormValues } from './branchPayload';

/**
 * Every key the update body may carry. `satisfies` makes a key the API does
 * not have a type error, so the list cannot drift from the body builder.
 */
const UPDATE_KEYS = ['nameAr', 'nameEn', 'address'] as const satisfies readonly (keyof UpdateBranchDto)[];

/** What antd's onFinish hands over when editing: every optional field emptied. */
const emptied: BranchFormValues = {
  code: 'B2',
  nameAr: 'فرع 2',
  nameEn: '',
  address: '',
};

const filled: BranchFormValues = {
  code: 'B2',
  nameAr: '  فرع 2  ',
  nameEn: ' Branch 2 ',
  address: 'Amman',
};

/** The body as JSON sends it: undefined keys disappear, null stays. */
const sent = (body: object) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

describe('branch form bodies', () => {
  it('an edit sends an emptied optional field as null, so it is cleared', () => {
    expect(sent(branchUpdateBody(emptied))).toEqual({ nameAr: 'فرع 2', nameEn: null, address: null });
  });

  it('an edit sends only the update fields: never the code', () => {
    const keys = Object.keys(sent(branchUpdateBody(filled)));
    expect(keys).not.toContain('code');
    for (const key of keys) expect(UPDATE_KEYS).toContain(key);
  });

  it('an edit trims the filled values', () => {
    expect(sent(branchUpdateBody(filled))).toEqual({ nameAr: 'فرع 2', nameEn: 'Branch 2', address: 'Amman' });
  });

  it('a space-only optional field counts as empty on edit (null) and on create (absent)', () => {
    const spaces: BranchFormValues = { code: 'B3', nameAr: 'فرع 3', nameEn: '   ', address: ' ' };
    expect(sent(branchUpdateBody(spaces))).toEqual({ nameAr: 'فرع 3', nameEn: null, address: null });
    expect(sent(branchCreateBody(spaces))).toEqual({ code: 'B3', nameAr: 'فرع 3' });
  });

  it('a create leaves an empty optional field out and sends the code', () => {
    const body: CreateBranchDto = branchCreateBody(emptied);
    expect(sent(body)).toEqual({ code: 'B2', nameAr: 'فرع 2' });
  });

  it('a create sends the filled values, trimmed', () => {
    expect(sent(branchCreateBody(filled))).toEqual({ code: 'B2', nameAr: 'فرع 2', nameEn: 'Branch 2', address: 'Amman' });
  });
});
