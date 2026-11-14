import { describe, expect, it } from 'vitest';
import { partyFields, type PartyColumn } from './JournalLinesGrid';
import {
  firstLineProblem,
  lineParty,
  partyKindOf,
  partyNeedByAccount,
  sideOfPartyType,
  type PartyNeed,
} from './journalLineChecks';

type Flags = { id: string; isControl: boolean; controlType: 'CUSTOMERS' | 'SUPPLIERS' | 'CASH' | 'BANK' | null };

const CHART: Flags[] = [
  { id: 'cash', isControl: false, controlType: 'CASH' },
  { id: 'bank', isControl: false, controlType: 'BANK' },
  { id: 'ar', isControl: true, controlType: 'CUSTOMERS' },
  { id: 'ap', isControl: true, controlType: 'SUPPLIERS' },
  { id: 'exp', isControl: false, controlType: null },
];

describe('partyNeedByAccount (decision D-2, as PostingService.validateLines)', () => {
  it('asks for a customer on a customers account and a supplier on a suppliers account', () => {
    const needs = partyNeedByAccount(CHART, []);
    expect(needs.get('ar')).toBe('CUSTOMER');
    expect(needs.get('ap')).toBe('SUPPLIER');
  });

  it('asks for no party on cash, bank and plain accounts', () => {
    const needs = partyNeedByAccount(CHART, []);
    expect([...needs.keys()].sort()).toEqual(['ap', 'ar']);
  });

  it('follows the control type even without the control flag, as the API does', () => {
    const needs = partyNeedByAccount([{ id: 'ar2', isControl: false, controlType: 'CUSTOMERS' }], []);
    expect(needs.get('ar2')).toBe('CUSTOMER');
  });

  it('asks for a party of either side on a control account of no side', () => {
    const needs = partyNeedByAccount(
      [
        { id: 'ctl', isControl: true, controlType: null },
        { id: 'ctlCash', isControl: true, controlType: 'CASH' },
      ],
      [],
    );
    expect(needs.get('ctl')).toBe('ANY');
    expect(needs.get('ctlCash')).toBe('ANY');
  });

  it('treats the account mapped as a control account on a legacy chart as one', () => {
    const legacy: Flags[] = [
      { id: 'oldAr', isControl: false, controlType: null },
      { id: 'oldAp', isControl: false, controlType: null },
    ];
    const needs = partyNeedByAccount(legacy, [
      { mappingKey: 'CUSTOMERS_CONTROL', accountId: 'oldAr' },
      { mappingKey: 'SUPPLIERS_CONTROL', accountId: 'oldAp' },
      { mappingKey: 'SALES', accountId: 'exp' },
      { mappingKey: 'ROUNDING', accountId: null },
    ]);
    expect(needs.get('oldAr')).toBe('CUSTOMER');
    expect(needs.get('oldAp')).toBe('SUPPLIER');
    expect(needs.has('exp')).toBe(false);
  });

  it("lets the account's own flags win over its mapping", () => {
    const needs = partyNeedByAccount(CHART, [{ mappingKey: 'SUPPLIERS_CONTROL', accountId: 'ar' }]);
    expect(needs.get('ar')).toBe('CUSTOMER');
  });

  it('copes with data still loading', () => {
    expect(partyNeedByAccount(undefined, undefined).size).toBe(0);
  });
});

describe('firstLineProblem', () => {
  const needs = partyNeedByAccount(CHART, []);

  it('accepts plain lines and control lines that carry a party', () => {
    expect(
      firstLineProblem(
        [
          { accountId: 'ar', debit: '50', partyId: '7' },
          { accountId: 'exp', credit: '50' },
        ],
        needs,
      ),
    ).toBeNull();
  });

  it('names the customers row that has no customer', () => {
    expect(
      firstLineProblem(
        [
          { accountId: 'exp', debit: '50' },
          { accountId: 'ar', credit: '50' },
        ],
        needs,
      ),
    ).toEqual({ line: 2, index: 1, rule: 'PARTY_REQUIRED', need: 'CUSTOMER' });
  });

  it('asks for a supplier on the payables account', () => {
    expect(
      firstLineProblem([{ accountId: 'ap', debit: '5' }, { accountId: 'cash', credit: '5' }], needs),
    ).toMatchObject({ line: 1, rule: 'PARTY_REQUIRED', need: 'SUPPLIER' });
  });

  it('wants exactly one of debit / credit, counting rows as the grid shows them', () => {
    const lines = [
      { accountId: 'cash', debit: '5' },
      {}, // empty row: skipped, but still row 2 on screen
      { accountId: 'exp', debit: '0', credit: '' },
      { accountId: 'exp', debit: '1', credit: '1' },
    ];
    expect(firstLineProblem(lines, needs)).toMatchObject({ line: 3, index: 2, rule: 'ONE_SIDE' });
    expect(firstLineProblem([lines[0], lines[3]], needs)).toMatchObject({ line: 2, rule: 'ONE_SIDE' });
  });

  it('treats amounts that round to 0.000 as empty, like the API', () => {
    expect(
      firstLineProblem([{ accountId: 'cash', debit: '0.0004' }, { accountId: 'exp', credit: '1' }], needs),
    ).toMatchObject({ line: 1, rule: 'ONE_SIDE' });
    expect(
      firstLineProblem([{ accountId: 'cash', debit: '0.0005' }, { accountId: 'exp', credit: '1' }], needs),
    ).toBeNull();
  });

  it('checks debit / credit before the party on the same row, in the API order', () => {
    expect(firstLineProblem([{ accountId: 'ar' }, { accountId: 'exp', credit: '1' }], needs)).toMatchObject({
      line: 1,
      rule: 'ONE_SIDE',
    });
  });
});

describe('partyKindOf', () => {
  it('maps control types to the party type the API expects', () => {
    expect(partyKindOf('CUSTOMERS')).toBe('CUSTOMER');
    expect(partyKindOf('SUPPLIERS')).toBe('SUPPLIER');
    expect(partyKindOf('CASH')).toBeUndefined();
    expect(partyKindOf(null)).toBeUndefined();
  });
});

describe('partyFields (what a line sends)', () => {
  const column: PartyColumn = {
    kindByAccount: new Map<string, PartyNeed>([
      ['ar', 'CUSTOMER'],
      ['ctl', 'ANY'],
    ]),
    options: { CUSTOMER: [], SUPPLIER: [], ANY: [] },
    onSearch: { CUSTOMER: () => {}, SUPPLIER: () => {}, ANY: () => {} },
    sideOf: (id) => (id === 's1' ? 'SUPPLIER' : id === 'c1' ? 'CUSTOMER' : undefined),
  };

  it("sends the account's side on a customers / suppliers account", () => {
    expect(partyFields({ key: 1, accountId: 'ar', partyId: 'c1' }, column)).toEqual({
      partyType: 'CUSTOMER',
      partyId: 'c1',
    });
  });

  it("sends the party's own side on a control account of no side", () => {
    expect(partyFields({ key: 1, accountId: 'ctl', partyId: 's1' }, column)).toEqual({
      partyType: 'SUPPLIER',
      partyId: 's1',
    });
    // An unknown party sends nothing: the API then names the line (PARTY_REQUIRED).
    expect(partyFields({ key: 1, accountId: 'ctl', partyId: 'x' }, column)).toEqual({});
  });

  it('sends no party on other accounts, even one left over from an earlier account', () => {
    expect(partyFields({ key: 1, accountId: 'exp', partyId: 'c1' }, column)).toEqual({});
    expect(partyFields({ key: 1, accountId: 'ar' }, column)).toEqual({});
  });
});

describe('a party on a control account of no side (ANY)', () => {
  const needs = new Map<string, PartyNeed>([
    ['ctl', 'ANY'],
    ['exp', 'CUSTOMER'],
  ]);
  const lines = [
    { accountId: 'ctl', debit: '5', partyId: 'p1' },
    { accountId: 'exp', credit: '5', partyId: 'c1' },
  ];

  it('counts only once its side is known, the same condition partyFields sends on', () => {
    // Side unknown (party not loaded): partyFields would send no party, so the check refuses the row.
    expect(firstLineProblem(lines, needs, () => undefined)).toMatchObject({
      line: 1,
      rule: 'PARTY_REQUIRED',
      need: 'ANY',
    });
    expect(firstLineProblem(lines, needs)).toMatchObject({ line: 1, rule: 'PARTY_REQUIRED' });
    expect(firstLineProblem(lines, needs, () => 'SUPPLIER')).toBeNull();
  });

  it('lineParty sends the side of the account, or of the party on an ANY account', () => {
    expect(lineParty('CUSTOMER', 'c1')).toEqual({ partyType: 'CUSTOMER', partyId: 'c1' });
    expect(lineParty('ANY', 'p1', () => 'SUPPLIER')).toEqual({ partyType: 'SUPPLIER', partyId: 'p1' });
    expect(lineParty('ANY', 'p1', () => undefined)).toBeUndefined();
    expect(lineParty('SUPPLIER', null)).toBeUndefined();
  });

  it('gives a BOTH party the customer side', () => {
    expect(sideOfPartyType('BOTH')).toBe('CUSTOMER');
    expect(sideOfPartyType('CUSTOMER')).toBe('CUSTOMER');
    expect(sideOfPartyType('SUPPLIER')).toBe('SUPPLIER');
  });
});
