import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mariadb from 'mariadb';
import type { Env } from '../../common/config/env.validation.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { expectedSchemaVersion } from '../../prisma/schema-version.js';
import { TenantDatabaseProvisioner } from '../../platform/tenancy/database-provisioner.service.js';
import { migrateDatabase } from '../../platform/tenancy/migrate-runner.js';
import { onAbort } from '../abort-cleanup.js';
import { backupKey, createDecryptStream, keyProblem } from './backup-crypto.js';
import {
  encryptionOf,
  MANIFEST_FILE,
  parseBackupManifest,
  resolveBackupFolder,
  sha256File,
} from './manifest.js';
import { dropTenantDatabaseTables } from '../tenant-purge.service.js';
import { dbTarget, runTool, toolVersion, withOptionFile } from './mysql-tools.js';

@Injectable()
export class BackupRestoreTenantService {
  private readonly logger = new Logger(BackupRestoreTenantService.name);

  // systemPrisma: tenant state and restore audit rows are control-plane data.
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly databases: TenantDatabaseProvisioner,
  ) {}

  async run(which: string, tenantId: bigint, confirmName: string) {
    if (this.prisma.tenancyMode !== 'isolated') {
      throw new Error('Tenant restore is available only in isolated mode; use the documented manual restore procedure.');
    }
    const root = path.resolve(this.config.get('BACKUP_DIR', { infer: true }));
    const folder = await resolveBackupFolder(which, root);
    const manifest = parseBackupManifest(await readFile(path.join(folder, MANIFEST_FILE), 'utf8'));
    if (manifest.format !== 3) throw new Error('Tenant restore requires a format 3 manifest');
    const tenant = manifest.tenantDatabases.find((entry) => entry.tenantId === tenantId.toString());
    if (!tenant) throw new Error(`Backup has no database for tenant ${tenantId}`);
    if (path.basename(tenant.file) !== tenant.file) throw new Error('Invalid tenant dump filename');
    const file = manifest.files.find((entry) => entry.name === tenant.file);
    if (!file) throw new Error('Tenant dump is missing from the manifest file list');
    const dumpPath = path.join(folder, tenant.file);
    const dumpStat = await stat(dumpPath);
    if (!dumpStat.size || dumpStat.size !== file.bytes || (await sha256File(dumpPath)) !== file.sha256) {
      throw new Error('Tenant dump checksum does not match the manifest');
    }
    const control = this.prisma.control();
    const [tenantRow, database] = await Promise.all([
      control.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }),
      control.tenantDatabase.findUnique({ where: { tenantId } }),
    ]);
    if (!tenantRow || !database) throw new Error(`Tenant ${tenantId} is not provisioned`);
    if (database.state !== 'ACTIVE' && database.state !== 'MIGRATING' && database.state !== 'RESTORING') {
      throw new Error(`Tenant database state ${database.state} is not restorable`);
    }
    if (tenantRow.name !== confirmName) throw new Error('Refused: --confirm must be the exact tenant name');

    const encryption = encryptionOf(manifest);
    const key = backupKey(this.config.get('BACKUP_ENCRYPTION_KEY', { infer: true }));
    if (encryption) {
      const problem = keyProblem(encryption.keyId, key);
      if (problem) throw new Error(problem);
    }
    const url = this.databases.databaseUrl(database);
    const target = dbTarget(url);
    const mysql = this.config.get('MYSQL_PATH', { infer: true });
    if (!(await toolVersion(mysql))) throw new Error(`Cannot run ${mysql}`);
    const logicalName = tenant.file.endsWith('.enc') ? tenant.file.slice(0, -4) : tenant.file;
    const dump =
      encryption && key
        ? await createDecryptStream(dumpPath, key, logicalName)
        : await openPlainDump(dumpPath);
    const previousState = database.state;
    let dropped = false;
    let completed = false;
    const setStateAndInvalidate = async (state: typeof previousState) => {
      try {
        await control.tenantDatabase.update({ where: { tenantId }, data: { state } });
      } catch {
        this.logger.error(`Could not restore tenant ${tenantId} state after a failed restore`);
      }
      try {
        await this.prisma.router.invalidate(tenantId);
      } catch {
        this.logger.error(`Could not invalidate tenant ${tenantId} router after a failed restore`);
      }
    };
    try {
      await control.tenantDatabase.update({ where: { tenantId }, data: { state: 'RESTORING' } });
      await this.prisma.router.invalidate(tenantId);
      const drainMs = this.config.get('TENANT_DB_STATE_TTL_MS', { infer: true }) + 5_000;
      console.error(`Waiting ${drainMs}ms for cached tenant requests to drain before restore`);
      const unregisterAbort = onAbort(() => setStateAndInvalidate(previousState));
      try {
        await this.waitForDrain(drainMs);
      } finally {
        unregisterAbort();
      }
      await withOptionFile(
        target,
        async (options) => {
          dropped = true;
          await dropTenantDatabaseTables(url);
          const { done, stdin } = runTool(
            mysql,
            [`--defaults-extra-file=${options}`, '--default-character-set=utf8mb4', target.database],
            { stdin: true },
          );
          const [client, feed] = await Promise.allSettled([done, pipeline(dump, createGunzip(), stdin!)]);
          if (feed.status === 'rejected' && (feed.reason as NodeJS.ErrnoException).code !== 'EPIPE') throw feed.reason;
          if (client.status === 'rejected') throw client.reason;
          if (feed.status === 'rejected') throw feed.reason;
        },
        os.tmpdir(),
      );
      const parsed = new URL(url);
      const connection = await mariadb.createConnection({
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 3306,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: decodeURIComponent(parsed.pathname.slice(1)),
      });
      let version: string | null;
      try {
        const rows = (await connection.query(
          `SELECT MAX(migration_name) AS version FROM _prisma_migrations
           WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        )) as { version: string | null }[];
        version = rows[0]?.version ?? null;
      } finally {
        await connection.end();
      }
      const expected = expectedSchemaVersion();
      if (version === null || version < expected) version = await migrateDatabase(url);
      await control.tenantDatabase.update({
        where: { tenantId },
        data: { state: 'ACTIVE', schemaVersion: version },
      });
      await this.prisma.router.invalidate(tenantId);
      completed = true;
      try {
        await control.auditLog.create({
          data: {
            tenantId,
            userId: null,
            action: 'job.backup_restore_tenant',
            entityType: 'tenant',
            entityId: tenantId.toString(),
            afterJson: { backup: manifest.name, schemaVersion: version },
          },
        });
      } catch (error) {
        this.logger.error(
          `Could not write restore audit row for tenant ${tenantId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
      return { tenantId: tenantId.toString(), backup: manifest.name, schemaVersion: version };
    } catch (error) {
      if (!completed) await setStateAndInvalidate(dropped ? 'RESTORING' : previousState);
      throw error;
    } finally {
      dump.destroy();
    }
  }

  private waitForDrain(drainMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(), drainMs);
      function cleanup() {
        clearTimeout(timer);
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
      }
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }
      function onSigint() {
        finish(new Error('Tenant restore interrupted by SIGINT'));
      }
      function onSigterm() {
        finish(new Error('Tenant restore interrupted by SIGTERM'));
      }
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
    });
  }
}

async function openPlainDump(file: string) {
  const stream = createReadStream(file);
  await new Promise<void>((resolve, reject) => {
    stream.once('open', () => resolve());
    stream.once('error', reject);
  });
  return stream;
}
