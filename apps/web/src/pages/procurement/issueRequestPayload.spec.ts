import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '../../auth/permissions';
import {
  issueFromRequestBody,
  issueRequestActions,
  issueRequestBody,
  issueRequestGaps,
  overRemainingLineIds,
} from './issueRequestPayload';

const allowOnly = (...granted: Permission[]) => (p: Permission) => granted.includes(p);

describe('issueRequestBody', () => {
  it('sends the date, warehouse, optional references and complete lines as strings', () => {
    const body = issueRequestBody(
      {
        requestDate: '2026-11-15',
        warehouseId: 'w1',
        costCenterId: 'cc1',
        expenseAccountId: 'ea1',
        notes: '  monthly  ',
      },
      [
        { itemId: 'i1', qty: '10.5', note: '  urgent  ' },
        { itemId: 'i2', qty: '3' },
      ],
    );
    expect(body).toEqual({
      requestDate: '2026-11-15',
      warehouseId: 'w1',
      costCenterId: 'cc1',
      expenseAccountId: 'ea1',
      notes: 'monthly',
      lines: [
        { itemId: 'i1', qty: '10.5', note: 'urgent' },
        { itemId: 'i2', qty: '3' },
      ],
    });
  });

  it('leaves out lines without an item or a positive quantity, and blank optional fields', () => {
    const body = issueRequestBody(
      { requestDate: '2026-11-15', warehouseId: 'w1', costCenterId: '', expenseAccountId: null, notes: '   ' },
      [
        { itemId: 'i1', qty: '0' },
        { itemId: 'i1', qty: '-2' },
        { itemId: null, qty: '4' },
        { itemId: 'i2', qty: '' },
        { itemId: 'i3', qty: 'abc' },
        { itemId: 'i4', qty: '2.000', note: '   ' },
      ],
    );
    expect(body).toEqual({
      requestDate: '2026-11-15',
      warehouseId: 'w1',
      lines: [{ itemId: 'i4', qty: '2' }],
    });
  });

  it('is null while the warehouse or every line is missing', () => {
    expect(issueRequestBody({ requestDate: '2026-11-15' }, [{ itemId: 'i1', qty: '1' }])).toBeNull();
    expect(issueRequestBody({ requestDate: '2026-11-15', warehouseId: 'w1' }, [{ qty: '1' }])).toBeNull();
  });
});

describe('issueRequestGaps', () => {
  it('names what the editor still lacks', () => {
    expect(issueRequestGaps({}, [])).toEqual(['warehouse', 'lines']);
    expect(issueRequestGaps({ warehouseId: 'w1' }, [{ itemId: 'i1', qty: '1' }])).toEqual([]);
    expect(issueRequestGaps({ warehouseId: 'w1' }, [{ itemId: 'i1', qty: '0' }])).toEqual(['lines']);
  });
});

describe('issueFromRequestBody and overRemainingLineIds', () => {
  const rows = [
    { issueRequestLineId: 'l1', remainingQty: '2.5', qty: '2.5' },
    { issueRequestLineId: 'l2', remainingQty: '4', qty: '1.25' },
    { issueRequestLineId: 'l3', remainingQty: '0', qty: null },
  ];

  it('sends the rows that issue a positive quantity, as strings', () => {
    expect(issueFromRequestBody('2026-11-16', rows)).toEqual({
      noteDate: '2026-11-16',
      lines: [
        { issueRequestLineId: 'l1', qty: '2.5' },
        { issueRequestLineId: 'l2', qty: '1.25' },
      ],
    });
  });

  it('refuses a quantity above what remains, and names that line', () => {
    const over = [{ issueRequestLineId: 'l1', remainingQty: '2.5', qty: '2.6' }, ...rows.slice(1)];
    expect(overRemainingLineIds(over)).toEqual(['l1']);
    expect(issueFromRequestBody('2026-11-16', over)).toBeNull();
  });

  it('is null when no row issues anything', () => {
    expect(issueFromRequestBody('2026-11-16', [{ issueRequestLineId: 'l3', remainingQty: '0', qty: '' }])).toBeNull();
    expect(overRemainingLineIds(rows)).toEqual([]);
  });
});

describe('issueRequestActions', () => {
  const NOTHING = allowOnly();

  it('offers edit, delete and submit on a draft to a request manager', () => {
    expect(issueRequestActions('DRAFT', allowOnly(PERMISSIONS.PURCHASE_REQUEST_MANAGE))).toEqual([
      'edit',
      'delete',
      'submit',
    ]);
    expect(issueRequestActions('DRAFT', NOTHING)).toEqual([]);
  });

  it('splits a submitted request between the approver and the manager', () => {
    expect(issueRequestActions('SUBMITTED', allowOnly(PERMISSIONS.PURCHASE_APPROVE))).toEqual(['approve', 'reject']);
    expect(issueRequestActions('SUBMITTED', allowOnly(PERMISSIONS.PURCHASE_MANAGE))).toEqual(['cancel']);
  });

  it('offers issue to a stock.movement holder on an approved request, and close and cancel to purchase.manage', () => {
    expect(issueRequestActions('APPROVED', allowOnly(PERMISSIONS.STOCK_MOVEMENT))).toEqual(['issue']);
    expect(issueRequestActions('APPROVED', allowOnly(PERMISSIONS.PURCHASE_MANAGE))).toEqual(['cancel', 'close']);
    expect(
      issueRequestActions('APPROVED', allowOnly(PERMISSIONS.STOCK_MOVEMENT, PERMISSIONS.PURCHASE_MANAGE)),
    ).toEqual(['issue', 'cancel', 'close']);
  });

  it('offers nothing once a request is rejected, cancelled or closed', () => {
    const all = allowOnly(
      PERMISSIONS.PURCHASE_REQUEST_MANAGE,
      PERMISSIONS.PURCHASE_APPROVE,
      PERMISSIONS.PURCHASE_MANAGE,
      PERMISSIONS.STOCK_MOVEMENT,
    );
    for (const status of ['REJECTED', 'CANCELLED', 'CLOSED'] as const) {
      expect(issueRequestActions(status, all)).toEqual([]);
    }
  });
});
