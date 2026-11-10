import { describe, expect, it } from 'vitest';
import { dec } from '../format/number';
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
});
