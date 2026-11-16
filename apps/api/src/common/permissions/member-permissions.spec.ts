import { Decimal } from '../decimal/decimal.utils.js';
import { effectiveMemberPermissions, MEMBER_PERMISSION_CODES } from './member-permissions.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from './permissions.js';

describe('Member purchase permissions (ADR-024 §3)', () => {
  it('are four catalog codes, which the owner role holds and no other role', () => {
    expect([...MEMBER_PERMISSION_CODES]).toEqual(['purchase.direct', 'purchase.approve', 'sales.approve', 'stock.issue_without_request']);
    for (const code of MEMBER_PERMISSION_CODES) {
      expect(Object.values(PERMISSIONS)).toContain(code);
      expect(ROLE_PERMISSIONS.OWNER).toContain(code);
      for (const role of ['ACCOUNTANT', 'STOREKEEPER', 'CASHIER', 'VIEWER']) {
        expect([role, ROLE_PERMISSIONS[role]!.includes(code)]).toEqual([role, false]);
      }
    }
  });

  it('gives an owner all three with no limit, whatever is stored', () => {
    expect(effectiveMemberPermissions('OWNER', [{ permissionCode: 'purchase.approve', amountLimit: new Decimal('5') }])).toEqual({
      codes: ['purchase.direct', 'purchase.approve', 'sales.approve', 'stock.issue_without_request'],
      approvalLimit: null,
      salesApprovalLimit: null,
    });
  });

  it('gives sales.approve its own limit, separate from purchase.approve (ADR-027 §6)', () => {
    expect(
      effectiveMemberPermissions('CASHIER', [
        { permissionCode: 'sales.approve', amountLimit: new Decimal('700') },
        { permissionCode: 'purchase.approve', amountLimit: null },
      ]),
    ).toEqual({ codes: ['purchase.approve', 'sales.approve'], approvalLimit: null, salesApprovalLimit: '700.000' });
  });

  it('gives a member the stored fixed codes in catalog order, and the approval limit with 3 decimals', () => {
    expect(
      effectiveMemberPermissions('CASHIER', [
        { permissionCode: 'stock.issue_without_request', amountLimit: null },
        { permissionCode: 'purchase.approve', amountLimit: new Decimal('1500.5') },
        { permissionCode: 'journal.post', amountLimit: null },
      ]),
    ).toEqual({ codes: ['purchase.approve', 'stock.issue_without_request'], approvalLimit: '1500.500', salesApprovalLimit: null });
  });

  it('has no limit without one stored, nor without purchase.approve', () => {
    expect(effectiveMemberPermissions('VIEWER', [{ permissionCode: 'purchase.approve', amountLimit: null }]).approvalLimit).toBeNull();
    expect(effectiveMemberPermissions('VIEWER', [])).toEqual({ codes: [], approvalLimit: null, salesApprovalLimit: null });
  });
});
