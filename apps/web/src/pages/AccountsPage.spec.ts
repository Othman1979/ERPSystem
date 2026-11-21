import { describe, expect, it } from 'vitest';
import { dec } from '../format/number';
import { selectCashBank } from '../hooks/useAccounts';
import { applyBalances, buildTree, type Account } from './AccountsPage';

const acc = (
  id: string,
  code: string,
  parentId: string | null,
  normalBalance: 'DEBIT' | 'CREDIT',
): Account =>
  ({
    id,
    code,
    nameAr: code,
    nameEn: null,
    parentId,
    level: parentId ? 2 : 1,
    accountType: normalBalance === 'DEBIT' ? 'ASSET' : 'LIABILITY',
    normalBalance,
    isActive: true,
    isPostable: true,
    isControl: false,
    controlType: null,
  }) as Account;

describe('applyBalances', () => {
  it('rolls child totals up to the parent exactly (no float drift)', () => {
    const tree = buildTree([
      acc('1', '11', null, 'DEBIT'),
      acc('2', '11-01', '1', 'DEBIT'),
      acc('3', '11-02', '1', 'DEBIT'),
    ]);
    applyBalances(
      tree,
      new Map([
        ['2', { debit: dec('0.1'), credit: dec('0') }],
        ['3', { debit: dec('0.2'), credit: dec('0.05') }],
      ]),
    );
    const parent = tree[0];
    expect(parent.balDebit.toString()).toBe('0.3');
    expect(parent.balCredit.toString()).toBe('0.05');
    expect(parent.balBalance.toString()).toBe('0.25');
  });

  it('computes credit-normal balances as credit minus debit, negative when overdrawn', () => {
    const tree = buildTree([acc('9', '21', null, 'CREDIT')]);
    applyBalances(tree, new Map([['9', { debit: dec('500'), credit: dec('300') }]]));
    expect(tree[0].balBalance.toString()).toBe('-200');
    expect(tree[0].balBalance.isNegative()).toBe(true);
  });

  it('rolls a bank child balance up to its non-postable parent', () => {
    const parent = { ...acc('10', '1102', null, 'DEBIT'), isPostable: false, controlType: 'BANK' as const };
    const child = { ...acc('11', '1102-01', '10', 'DEBIT'), controlType: 'BANK' as const };
    const tree = buildTree([parent, child]);
    applyBalances(tree, new Map([['11', { debit: dec('10'), credit: dec('0') }]]));
    expect(tree[0].balDebit.toString()).toBe('10');
  });
});

describe('selectCashBank', () => {
  it('offers only postable cash and bank leaves', () => {
    const parent = { ...acc('1', '1102', null, 'DEBIT'), controlType: 'BANK' as const, isPostable: false };
    const child = { ...acc('2', '1102-01', '1', 'DEBIT'), controlType: 'BANK' as const };
    const inactive = { ...acc('3', '1101-02', null, 'DEBIT'), controlType: 'CASH' as const, isActive: false };
    const otherControl = { ...acc('4', '1201', null, 'DEBIT'), controlType: null };
    expect(selectCashBank([parent, child, inactive, otherControl])).toEqual([child, inactive]);
  });
});
