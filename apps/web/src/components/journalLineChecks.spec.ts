import { describe, expect, it } from 'vitest';
import { firstLineProblem, partyTypeFor, type LineAccount } from './journalLineChecks';

const accounts = new Map<string, LineAccount>([
  ['cash', { code: '1101', isControl: false, controlType: 'CASH' }],
  ['ar', { code: '1103', isControl: true, controlType: 'CUSTOMERS' }],
  ['ap', { code: '2101', isControl: true, controlType: 'SUPPLIERS' }],
  ['exp', { code: '5204', isControl: false, controlType: null }],
]);

describe('firstLineProblem', () => {
  it('accepts plain lines and control lines that carry a party', () => {
    expect(
      firstLineProblem(
        [
          { accountId: 'ar', debit: '50', partyId: '7' },
          { accountId: 'exp', credit: '50' },
        ],
        accounts,
      ),
    ).toBeNull();
  });

  it('names the customers line that has no customer', () => {
    expect(
      firstLineProblem(
        [
          { accountId: 'exp', debit: '50' },
          { accountId: 'ar', credit: '50' },
        ],
        accounts,
      ),
    ).toEqual({ line: 2, rule: 'PARTY_REQUIRED', accountCode: '1103', partyType: 'CUSTOMER' });
  });

  it('asks for a supplier on the payables account', () => {
    expect(
      firstLineProblem([{ accountId: 'ap', debit: '5' }, { accountId: 'cash', credit: '5' }], accounts),
    ).toMatchObject({ line: 1, rule: 'PARTY_REQUIRED', partyType: 'SUPPLIER' });
  });

  it('wants exactly one of debit / credit, counting rows as the grid shows them', () => {
    const lines = [
      { accountId: 'cash', debit: '5' },
      {}, // empty row: skipped, but still row 2 on screen
      { accountId: 'exp', debit: '0', credit: '' },
      { accountId: 'exp', debit: '1', credit: '1' },
    ];
    expect(firstLineProblem(lines, accounts)).toMatchObject({ line: 3, rule: 'ONE_SIDE' });
    expect(firstLineProblem([lines[0], lines[3]], accounts)).toMatchObject({ line: 2, rule: 'ONE_SIDE' });
  });

  it('treats amounts that round to 0.000 as empty, like the API', () => {
    expect(
      firstLineProblem([{ accountId: 'cash', debit: '0.0004' }, { accountId: 'exp', credit: '1' }], accounts),
    ).toMatchObject({ line: 1, rule: 'ONE_SIDE' });
  });
});

describe('partyTypeFor', () => {
  it('maps control types to the party type the API expects', () => {
    expect(partyTypeFor(accounts.get('ar'))).toBe('CUSTOMER');
    expect(partyTypeFor(accounts.get('ap'))).toBe('SUPPLIER');
    expect(partyTypeFor(accounts.get('exp'))).toBeNull();
  });
});
