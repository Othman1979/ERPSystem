import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mariadb from 'mariadb';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Env } from '../../common/config/env.validation.js';
import { openSecret, sealSecret } from '../../common/crypto/secret-box.js';
import type { TenantDatabase } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { expectedSchemaVersion } from '../../prisma/schema-version.js';

export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type SqlConnectionFactory = (options: Parameters<typeof mariadb.createConnection>[0]) => Promise<SqlConnection>;

export interface ProvisionedDatabase {
  host: string;
  port: number;
  databaseName: string;
  dbUser: string;
  password: string;
  passwordSealed: string;
  url: string;
}

export function validateDatabaseIdentifier(value: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(value)) throw new Error('Invalid tenant database identifier');
  return value;
}

function quoteSqlValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function databaseCreationStatements(
  databaseName: string,
  dbUser: string,
  userHost: string,
  password: string,
): Array<{ sql: string; values?: unknown[] }> {
  validateDatabaseIdentifier(databaseName);
  validateDatabaseIdentifier(dbUser);
  const account = `'${quoteSqlValue(dbUser)}'@'${quoteSqlValue(userHost)}'`;
  return [
    {
      sql: `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    },
    { sql: `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, values: [password] },
    { sql: `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO ${account}` },
  ];
}

type PoolRow = {
  id: bigint;
  host: string;
  port: number;
  database_name: string;
  db_user: string;
  password_sealed: string;
  schema_version: string | null;
};

@Injectable()
export class TenantDatabaseProvisioner {
  // systemPrisma: provisioning metadata and pool claims belong to the control plane.
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async createDatabase(connectionFactory: SqlConnectionFactory = mariadb.createConnection): Promise<ProvisionedDatabase> {
    const adminUrl = this.config.get('TENANT_DB_ADMIN_URL', { infer: true });
    if (!adminUrl) throw new Error('TENANT_DB_ADMIN_URL is required for create provisioning');
    const admin = new URL(adminUrl);
    const prefix = this.config.get('TENANT_DB_NAME_PREFIX', { infer: true });
    const databaseName = validateDatabaseIdentifier(`${prefix}${randomBytes(6).toString('hex')}`);
    const dbUser = databaseName;
    const password = randomBytes(32).toString('base64url');
    const userHost = this.config.get('TENANT_DB_USER_HOST', { infer: true });
    const statements = databaseCreationStatements(databaseName, dbUser, userHost, password);
    const connection = await connectionFactory({
      host: admin.hostname,
      port: admin.port ? Number(admin.port) : 3306,
      user: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password),
      database: admin.pathname.replace(/^\//, '') || 'mysql',
      connectTimeout: 10_000,
    });
    try {
      for (const statement of statements) {
        await connection.query(statement.sql, statement.values);
      }
    } finally {
      await connection.end();
    }

    const host = this.config.get('TENANT_DB_HOST', { infer: true }) ?? admin.hostname;
    const routeUrl = new URL(adminUrl);
    routeUrl.hostname = host;
    routeUrl.pathname = `/${databaseName}`;
    routeUrl.username = dbUser;
    routeUrl.password = password;
    routeUrl.search = '';
    routeUrl.hash = '';
    return {
      host,
      port: admin.port ? Number(admin.port) : 3306,
      databaseName,
      dbUser,
      password,
      passwordSealed: sealSecret(password, this.config.get('TENANT_DB_SECRET_KEY', { infer: true })),
      url: routeUrl.toString(),
    };
  }

  async dropCreatedDatabase(database: ProvisionedDatabase): Promise<void> {
    const adminUrl = this.config.get('TENANT_DB_ADMIN_URL', { infer: true });
    if (!adminUrl) throw new Error('TENANT_DB_ADMIN_URL is required for create provisioning');
    const admin = new URL(adminUrl);
    const userHost = this.config.get('TENANT_DB_USER_HOST', { infer: true });
    const connection = await mariadb.createConnection({
      host: admin.hostname,
      port: admin.port ? Number(admin.port) : 3306,
      user: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password),
      database: admin.pathname.replace(/^\//, '') || 'mysql',
      connectTimeout: 10_000,
    });
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${validateDatabaseIdentifier(database.databaseName)}\``);
      await connection.query(
        `DROP USER IF EXISTS '${quoteSqlValue(validateDatabaseIdentifier(database.dbUser))}'@'${quoteSqlValue(userHost)}'`,
      );
    } finally {
      await connection.end();
    }
  }

  async claimPoolDatabase(tx: Prisma.TransactionClient, tenantId: bigint): Promise<TenantDatabase | null> {
    const expected = expectedSchemaVersion();
    const rows = await tx.$queryRaw<PoolRow[]>`
      SELECT id, host, port, database_name, db_user, password_sealed, schema_version
      FROM tenant_db_pool
      WHERE claimed_by_tenant_id IS NULL
      ORDER BY (schema_version = ${expected}) DESC, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const row = rows[0];
    if (!row) return null;
    const claimedAt = new Date();
    await tx.tenantDbPool.update({
      where: { id: row.id },
      data: { claimedByTenantId: tenantId, claimedAt },
    });
    return tx.tenantDatabase.create({
      data: {
        tenantId,
        host: row.host,
        port: row.port,
        databaseName: row.database_name,
        dbUser: row.db_user,
        passwordSealed: row.password_sealed,
        schemaVersion: row.schema_version,
        state: 'PROVISIONING',
      },
    });
  }

  async recordProvisionedDatabase(
    tx: Prisma.TransactionClient,
    tenantId: bigint,
    database: ProvisionedDatabase,
  ): Promise<TenantDatabase> {
    return tx.tenantDatabase.create({
      data: {
        tenantId,
        host: database.host,
        port: database.port,
        databaseName: database.databaseName,
        dbUser: database.dbUser,
        passwordSealed: database.passwordSealed,
        state: 'PROVISIONING',
      },
    });
  }

  async countFreePoolRows(): Promise<number> {
    return this.prisma.control().tenantDbPool.count({ where: { claimedByTenantId: null } });
  }

  databaseUrl(database: Pick<TenantDatabase, 'host' | 'port' | 'databaseName' | 'dbUser' | 'passwordSealed'>): string {
    const url = new URL(this.config.get('TENANT_DB_ADMIN_URL', { infer: true }) ?? this.config.get('DATABASE_URL', { infer: true }));
    url.hostname = database.host;
    url.port = String(database.port);
    url.pathname = `/${database.databaseName}`;
    url.username = database.dbUser;
    url.password = openSecret(
      database.passwordSealed,
      this.config.get('TENANT_DB_SECRET_KEY', { infer: true }),
    );
    url.search = '';
    url.hash = '';
    return url.toString();
  }
}
