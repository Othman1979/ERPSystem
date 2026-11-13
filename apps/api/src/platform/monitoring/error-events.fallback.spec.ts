import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env.validation.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { ErrorEventsService, readFallbackLog } from './error-events.service.js';

/** A database that is out of disk: every write fails with errno 28. */
function fullDiskPrisma(): PrismaService {
  const fail = async (): Promise<never> => {
    throw Object.assign(new Error('Disk full (/var/tmp/#sql): Errcode: 28 - No space left on device'), { errno: 28 });
  };
  return { client: { errorEvent: { upsert: fail, update: fail } } } as unknown as PrismaService;
}

function config(file: string): ConfigService<Env, true> {
  return { get: (key: string) => (key === 'ERROR_LOG_FILE' ? file : undefined) } as unknown as ConfigService<Env, true>;
}

describe('error events: fallback file when the database cannot write (PLAT-31)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-fallback-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one parsable line with the fingerprint and no stack or secrets', async () => {
    const file = path.join(dir, 'logs', 'errors-fallback.log');
    const service = new ErrorEventsService(fullDiskPrisma(), config(file));

    await service.record({
      source: 'API',
      error: new TypeError('boom password=hunter2 for invoice 42'),
      method: 'POST',
      path: '/api/v1/invoices?token=abc',
      status: 500,
      tenantId: 7n,
      requestId: 'req-1',
    });

    const text = await readFile(file, 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('token=abc');
    expect(text).not.toContain('    at ');

    const { lines, bytes } = await readFallbackLog(file);
    expect(bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      source: 'API',
      name: 'TypeError',
      method: 'POST',
      path: '/api/v1/invoices',
      status: 500,
      tenantId: '7',
      userId: null,
      requestId: 'req-1',
      count: 1,
    });
    expect(lines[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0].dbError).toContain('Errcode: 28');
    expect(lines[0]).not.toHaveProperty('stack');
  });

  it('a failing append (the path cannot be created) does not throw', async () => {
    // A regular file where a folder is needed: the folder cannot be created.
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'not a folder');
    const service = new ErrorEventsService(fullDiskPrisma(), config(path.join(blocker, 'sub', 'errors.log')));

    await expect(service.record({ source: 'JOB', error: new Error('nightly failed'), path: 'backup' })).resolves.toBeUndefined();
  });

  it('reads no lines from a missing file, and skips lines that do not parse', async () => {
    expect(await readFallbackLog(path.join(dir, 'none.log'))).toEqual({ lines: [], bytes: 0 });

    const file = path.join(dir, 'mixed.log');
    await writeFile(
      file,
      [
        '{"fingerprint":"abc","source":"WEB","name":"Error","count":2}',
        'not json at all',
        '{"half":',
        '{"no":"fingerprint"}',
        '',
      ].join('\n'),
    );
    const { lines } = await readFallbackLog(file);
    expect(lines.map((l) => l.fingerprint)).toEqual(['abc']);
  });
});
