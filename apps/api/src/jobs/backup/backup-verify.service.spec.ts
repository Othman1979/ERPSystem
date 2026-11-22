import { tenantMigrationVersionMatches } from './backup-verify.service.js';

describe('tenant backup migration versions', () => {
  const expected = '20261123130000_tenant_db_restoring_state';

  it('accepts the version recorded in the tenant manifest even when the running build is newer', () => {
    const backupVersion = '20261123120000_phase29b_tenant_db_pool';
    expect(tenantMigrationVersionMatches(backupVersion, backupVersion, expected)).toBe(true);
    expect(tenantMigrationVersionMatches(expected, backupVersion, expected)).toBe(false);
  });

  it('allows a null manifest version only when the dump is no newer than the running build', () => {
    expect(tenantMigrationVersionMatches('20261123120000_phase29b_tenant_db_pool', null, expected)).toBe(true);
    expect(tenantMigrationVersionMatches(expected, null, expected)).toBe(true);
    expect(tenantMigrationVersionMatches('20261123140000_future', null, expected)).toBe(false);
  });
});
