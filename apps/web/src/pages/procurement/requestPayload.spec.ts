import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '../../auth/permissions';
import {
  approvalBlockedAsOwnDocument,
  purchaseRequestBody,
  requestActions,
  type PurchaseRequestLineInput,
} from './requestPayload';

const allowOnly = (...granted: Permission[]) => (p: Permission) => granted.includes(p);
const REQUEST_MANAGER = allowOnly(PERMISSIONS.PURCHASE_REQUEST_MANAGE);
const APPROVER = allowOnly(PERMISSIONS.PURCHASE_APPROVE);
const MANAGER = allowOnly(PERMISSIONS.PURCHASE_MANAGE);
const EVERYTHING = allowOnly(
  PERMISSIONS.PURCHASE_REQUEST_MANAGE,
  PERMISSIONS.PURCHASE_APPROVE,
  PERMISSIONS.PURCHASE_MANAGE,
);
const NOTHING = allowOnly();

describe('purchaseRequestBody', () => {
  it('sends the date, the trimmed text and only complete lines as strings', () => {
    const lines: PurchaseRequestLineInput[] = [
      { itemId: 'i1', itemUnitId: 'u9', qty: '10.5', estimatedPrice: '2.250', note: '  urgent  ' },
      { itemId: 'i2', qty: '3' },
    ];
    const body = purchaseRequestBody(
      { requestDate: '2026-11-15', neededBy: '2026-11-30', notes: '  monthly  ' },
      lines,
    );
    expect(body).toEqual({
      requestDate: '2026-11-15',
      neededBy: '2026-11-30',
      notes: 'monthly',
      lines: [
        { itemId: 'i1', itemUnitId: 'u9', qty: '10.5', estimatedPrice: '2.250', note: 'urgent' },
        { itemId: 'i2', qty: '3' },
      ],
    });
    for (const line of body.lines) {
      for (const v of Object.values(line)) expect(typeof v).toBe('string');
    }
  });

  it('omits empty optional fields instead of sending blanks', () => {
    const body = purchaseRequestBody(
      { requestDate: '2026-11-15', neededBy: '  ', notes: '' },
      [{ itemId: 'i1', qty: '1', estimatedPrice: '', note: '   ', itemUnitId: null }],
    );
    expect(body).toEqual({ requestDate: '2026-11-15', lines: [{ itemId: 'i1', qty: '1' }] });
    expect(body).not.toHaveProperty('neededBy');
    expect(body).not.toHaveProperty('notes');
  });

  it('leaves out lines without an item, blank, zero, negative or invalid quantities', () => {
    const body = purchaseRequestBody({ requestDate: '2026-11-15' }, [
      { qty: '5' },
      { itemId: 'i1', qty: '' },
      { itemId: 'i1', qty: null },
      { itemId: 'i1', qty: '0' },
      { itemId: 'i1', qty: '-2' },
      { itemId: 'i1', qty: 'abc' },
      { itemId: 'i1', qty: '0.000001' },
    ]);
    expect(body.lines).toEqual([{ itemId: 'i1', qty: '0.000001' }]);
  });

  it('sends no lines for an empty grid', () => {
    expect(purchaseRequestBody({ requestDate: '2026-11-15' }, []).lines).toEqual([]);
  });
});

describe('requestActions', () => {
  it('lets a request manager edit, delete and submit a draft', () => {
    expect(requestActions('DRAFT', REQUEST_MANAGER)).toEqual(['edit', 'delete', 'submit']);
  });

  it('gives a draft no actions without purchase_request.manage', () => {
    expect(requestActions('DRAFT', MANAGER)).toEqual([]);
    expect(requestActions('DRAFT', NOTHING)).toEqual([]);
  });

  it('offers approve and reject to an approver, and cancel to a purchase manager, on a submitted request', () => {
    expect(requestActions('SUBMITTED', APPROVER)).toEqual(['approve', 'reject']);
    expect(requestActions('SUBMITTED', MANAGER)).toEqual(['cancel']);
    expect(requestActions('SUBMITTED', EVERYTHING)).toEqual(['approve', 'reject', 'cancel']);
  });

  it('offers nothing on a submitted request to someone with neither permission', () => {
    expect(requestActions('SUBMITTED', REQUEST_MANAGER)).toEqual([]);
  });

  it('offers cancel, close, an order and a quote on an approved request to a purchase manager', () => {
    expect(requestActions('APPROVED', MANAGER)).toEqual([
      'cancel',
      'close',
      'orderFromRequest',
      'quoteFromRequest',
    ]);
    expect(requestActions('APPROVED', APPROVER)).toEqual([]);
  });

  it('offers nothing once a request is rejected, cancelled or closed', () => {
    for (const status of ['REJECTED', 'CANCELLED', 'CLOSED'] as const) {
      expect(requestActions(status, EVERYTHING)).toEqual([]);
    }
  });
});

describe('approvalBlockedAsOwnDocument', () => {
  const none = { createdBy: null, updatedBy: null, submittedBy: null };

  it('blocks a non-owner from approving a request they created', () => {
    expect(
      approvalBlockedAsOwnDocument({ ...none, createdBy: 'u1', userId: 'u1', isOwner: false }),
    ).toBe(true);
  });

  it('blocks a non-owner who last edited the request', () => {
    expect(
      approvalBlockedAsOwnDocument({ ...none, createdBy: 'u2', updatedBy: 'u1', userId: 'u1', isOwner: false }),
    ).toBe(true);
  });

  it('blocks a non-owner who submitted the request', () => {
    expect(
      approvalBlockedAsOwnDocument({ ...none, createdBy: 'u2', submittedBy: 'u1', userId: 'u1', isOwner: false }),
    ).toBe(true);
  });

  it('lets the owner approve a request they touched', () => {
    expect(
      approvalBlockedAsOwnDocument({
        createdBy: 'u1',
        updatedBy: 'u1',
        submittedBy: 'u1',
        userId: 'u1',
        isOwner: true,
      }),
    ).toBe(false);
  });

  it('does not block when someone else touched the request, or the users are unknown', () => {
    expect(
      approvalBlockedAsOwnDocument({ createdBy: 'u2', updatedBy: 'u3', submittedBy: 'u4', userId: 'u1', isOwner: false }),
    ).toBe(false);
    expect(approvalBlockedAsOwnDocument({ ...none, createdBy: 'u1', userId: null, isOwner: false })).toBe(false);
    expect(approvalBlockedAsOwnDocument({ ...none, userId: 'u1', isOwner: false })).toBe(false);
  });
});
