import {
  TenantDatabaseProvisioner,
  type SqlConnection,
  type SqlConnectionFactory,
} from './database-provisioner.service.js';

describe('TenantDatabaseProvisioner', () => {
  const key = Buffer.alloc(32, 9).toString('base64');

  it('creates an identifier-safe database and user, then grants access', async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    let ended = 0;
    const query: SqlConnection['query'] = async (sql, values) => {
      statements.push({ sql, values });
      return undefined;
    };
    const end: SqlConnection['end'] = async () => {
      ended += 1;
    };
    let connectionOptions: Parameters<SqlConnectionFactory>[0] | undefined;
    const connectionFactory: SqlConnectionFactory = async (options) => {
      connectionOptions = options;
      return { query, end };
    };
    const values: Record<string, unknown> = {
      TENANT_DB_ADMIN_URL: 'mysql://admin:secret@admin.example.test:3307/mysql',
      TENANT_DB_NAME_PREFIX: 'erp_t_',
      TENANT_DB_USER_HOST: '%',
      TENANT_DB_HOST: 'tenant.example.test',
      TENANT_DB_SECRET_KEY: key,
    };
    const service = new TenantDatabaseProvisioner({ control: () => ({}) } as never, {
      get: (name: keyof typeof values) => values[name],
    } as never);

    const database = await service.createDatabase(connectionFactory);

    expect(database.databaseName).toMatch(/^erp_t_[a-f0-9]{12}$/);
    expect(database.dbUser).toBe(database.databaseName);
    expect(database.host).toBe('tenant.example.test');
    expect(database.port).toBe(3307);
    expect(database.password).toHaveLength(43);
    expect(database.passwordSealed).not.toContain(database.password);
    expect(connectionOptions).toEqual(
      expect.objectContaining({ host: 'admin.example.test', port: 3307, user: 'admin', database: 'mysql' }),
    );
    expect(statements.map(({ sql }) => sql)).toEqual([
      `CREATE DATABASE IF NOT EXISTS \`${database.databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      `CREATE USER IF NOT EXISTS '${database.dbUser}'@'%' IDENTIFIED BY ?`,
      `GRANT ALL PRIVILEGES ON \`${database.databaseName}\`.* TO '${database.dbUser}'@'%'`,
    ]);
    expect(statements[1]?.values).toEqual([database.password]);
    expect(ended).toBe(1);
    expect(new URL(database.url).pathname).toBe(`/${database.databaseName}`);
  });

  it('refuses invalid database and user identifiers before running SQL', async () => {
    let connected = false;
    const query: SqlConnection['query'] = async () => undefined;
    const connectionFactory = async () => {
      connected = true;
      return { query, end: async () => undefined };
    };
    const values: Record<string, unknown> = {
      TENANT_DB_ADMIN_URL: 'mysql://admin:secret@admin.example.test:3306/mysql',
      TENANT_DB_NAME_PREFIX: 'Bad-',
      TENANT_DB_USER_HOST: '%',
      TENANT_DB_SECRET_KEY: key,
    };
    const service = new TenantDatabaseProvisioner({ control: () => ({}) } as never, {
      get: (name: keyof typeof values) => values[name],
    } as never);

    await expect(service.createDatabase(connectionFactory)).rejects.toThrow(/Invalid tenant database identifier/);
    expect(connected).toBe(false);
  });
});
