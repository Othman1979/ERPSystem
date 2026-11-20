import { describe, expect, it } from 'vitest';
import { ar, en } from '../../i18n/locales';
import { groupPermissions, permissionKey } from './RolesTab';

const CODES = [
  'tenant.read',
  'journal.post',
  'item.manage',
  'sales.post',
  'purchase_request.manage',
  'treasury.manage',
  'reports.view',
];

describe('RolesTab permission groups', () => {
  it('puts each permission under its module, in a fixed order', () => {
    expect(groupPermissions(CODES)).toEqual([
      { group: 'general', codes: ['tenant.read', 'reports.view'] },
      { group: 'accounting', codes: ['journal.post'] },
      { group: 'inventory', codes: ['item.manage'] },
      { group: 'sales', codes: ['sales.post'] },
      { group: 'purchasing', codes: ['purchase_request.manage'] },
      { group: 'treasury', codes: ['treasury.manage'] },
    ]);
  });

  it('has an Arabic and English label for every permission it groups', () => {
    for (const code of CODES) {
      const key = permissionKey(code).replace('users.perm.', '') as keyof typeof ar.users.perm;
      expect(ar.users.perm[key]).toBeTruthy();
      expect(en.users.perm[key]).toBeTruthy();
    }
  });
});
