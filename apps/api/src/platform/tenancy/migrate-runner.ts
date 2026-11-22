import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../../generated/prisma/client.js';
import mariadb from 'mariadb';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { parseDatabaseUrl } from '../../prisma/prisma.service.js';
import { readSchemaVersion } from '../../prisma/schema-version.js';
import { POSTING_TX_OPTIONS } from '../../prisma/transaction-options.js';

const API_DIR = path.resolve(import.meta.dirname, '../../../');

export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export function migrationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Prisma migrate deploy failed')) return error.message;
  return error instanceof Error ? error.name : 'UnknownError';
}

function redactMigrationOutput(output: string, url: string): string {
  const parsed = new URL(url);
  const secrets = [url, parsed.password, decodeURIComponent(parsed.password)].filter(Boolean);
  let redacted = output;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted.replace(/mysql:\/\/[^\s'"<>]*?@/gi, 'mysql://[REDACTED]@');
}

function prismaCliEntry(): string {
  try {
    return createRequire(path.join(API_DIR, 'package.json')).resolve('prisma/build/index.js');
  } catch {
    throw new DomainError(ErrorCode.INTERNAL, 'Prisma CLI is not installed; run pnpm install in apps/api');
  }
}

export async function runMigrationCommand(
  url: string,
  spawnProcess: SpawnProcess = spawn,
  cliEntry = prismaCliEntry(),
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    let outputTail = Buffer.alloc(0);
    const capture = (chunk: Buffer | string) => {
      outputTail = Buffer.concat([outputTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (outputTail.length > 4096) outputTail = outputTail.subarray(outputTail.length - 4096);
    };
    try {
      child = spawnProcess(process.execPath, [cliEntry, 'migrate', 'deploy'], {
        cwd: API_DIR,
        env: { ...process.env, DATABASE_URL: url },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new DomainError(ErrorCode.INTERNAL, 'Could not start Prisma migrate deploy'));
      return;
    }
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', () => reject(new DomainError(ErrorCode.INTERNAL, 'Could not start Prisma migrate deploy')));
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        const tail = redactMigrationOutput(outputTail.toString('utf8'), url).trim();
        reject(new DomainError(ErrorCode.INTERNAL, tail ? `Prisma migrate deploy failed:\n${tail}` : 'Prisma migrate deploy failed'));
      }
    });
  });
}

export async function migrateDatabase(url: string): Promise<string> {
  await runMigrationCommand(url);
  const pool = mariadb.createPool(parseDatabaseUrl(url, { size: 1, acquireTimeoutMs: 10_000 }));
  const client = new PrismaClient({ adapter: new PrismaMariaDb(pool), transactionOptions: POSTING_TX_OPTIONS });
  try {
    const version = await readSchemaVersion(client);
    if (!version) throw new DomainError(ErrorCode.INTERNAL, 'Prisma migrate deploy completed without a finished migration');
    return version;
  } finally {
    await client.$disconnect();
    await pool.end();
  }
}
