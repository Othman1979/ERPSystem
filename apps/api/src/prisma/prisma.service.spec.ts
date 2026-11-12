import { parseDatabaseUrl, SESSION_INIT_SQL } from './prisma.service.js';

describe('database pool settings', () => {
  it('reads DATABASE_URL and runs the session setup on every new connection', () => {
    const config = parseDatabaseUrl('mysql://app%40x:p%40ss@db.example:3307/erp');
    expect(config).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'app@x',
      password: 'p@ss',
      database: 'erp',
      initSql: SESSION_INIT_SQL,
    });
  });

  it('turns snapshot isolation off only where MariaDB has it (11.6.2+), harmless elsewhere', () => {
    // A plain SET for older MariaDB / MySQL; the rest only inside a MariaDB version comment.
    expect(SESSION_INIT_SQL.startsWith('SET @erp_si = 0 ')).toBe(true);
    expect(SESSION_INIT_SQL).toContain('/*M!110602 , SESSION innodb_snapshot_isolation = OFF */');
  });
});
