import { describe, expect, it } from 'vitest';
import { isApprovalLimit, purchasePermissionsPayload, toPurchaseForm } from './purchasePermissions';

describe('purchase permissions editor values (ADR-024 §3)', () => {
  it('opens with the codes held and the approval limit', () => {
    expect(
      toPurchaseForm([
        { code: 'purchase.approve', amountLimit: '1500.500' },
        { code: 'stock.issue_without_request', amountLimit: null },
      ]),
    ).toEqual({ codes: ['purchase.approve', 'stock.issue_without_request'], approvalLimit: '1500.500' });
    expect(toPurchaseForm([])).toEqual({ codes: [], approvalLimit: undefined });
  });

  it('sends the ticked codes in API order, the limit on purchase.approve only', () => {
    expect(
      purchasePermissionsPayload({ codes: ['stock.issue_without_request', 'purchase.approve', 'purchase.direct'], approvalLimit: ' 250.5 ' }),
    ).toEqual({
      permissions: [
        { code: 'purchase.direct' },
        { code: 'purchase.approve', amountLimit: '250.5' },
        { code: 'stock.issue_without_request' },
      ],
    });
  });

  it('sends no limit when it is blank, or when purchase.approve is not ticked', () => {
    expect(purchasePermissionsPayload({ codes: ['purchase.approve'], approvalLimit: '  ' })).toEqual({
      permissions: [{ code: 'purchase.approve' }],
    });
    expect(purchasePermissionsPayload({ codes: ['purchase.direct'], approvalLimit: '99' })).toEqual({
      permissions: [{ code: 'purchase.direct' }],
    });
    expect(purchasePermissionsPayload({ codes: [] })).toEqual({ permissions: [] });
  });

  it('accepts the amounts the API accepts, and nothing else', () => {
    for (const ok of ['1', '0.001', '1500.5', '999999999999999.999']) expect([ok, isApprovalLimit(ok)]).toEqual([ok, true]);
    for (const bad of ['0', '0.000', '-5', '1.2345', '1e3', '1,500', '', '.5', '1234567890123456']) {
      expect([bad, isApprovalLimit(bad)]).toEqual([bad, false]);
    }
  });
});

describe('sales approval limit (ADR-027 §6)', () => {
  it('opens sales.approve with its own limit, apart from the purchase limit', () => {
    expect(
      toPurchaseForm([
        { code: 'sales.approve', amountLimit: '700' },
        { code: 'purchase.approve', amountLimit: null },
      ]),
    ).toEqual({ codes: ['sales.approve', 'purchase.approve'], approvalLimit: undefined, salesApprovalLimit: '700' });
  });

  it('sends each approval limit on its own code, in the API order', () => {
    expect(
      purchasePermissionsPayload({
        codes: ['sales.approve', 'purchase.approve'],
        approvalLimit: '100',
        salesApprovalLimit: ' 700 ',
      }),
    ).toEqual({
      permissions: [
        { code: 'purchase.approve', amountLimit: '100' },
        { code: 'sales.approve', amountLimit: '700' },
      ],
    });
  });

  it('sends the sales limit only when sales.approve is ticked and a limit was typed', () => {
    expect(purchasePermissionsPayload({ codes: ['purchase.direct'], salesApprovalLimit: '700' })).toEqual({
      permissions: [{ code: 'purchase.direct' }],
    });
    expect(purchasePermissionsPayload({ codes: ['sales.approve'], salesApprovalLimit: ' ' })).toEqual({
      permissions: [{ code: 'sales.approve' }],
    });
  });
});
