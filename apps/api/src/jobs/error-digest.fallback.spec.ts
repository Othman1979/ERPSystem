import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ErrorDigestService } from './error-digest.service.js';

/** The local webhook this spec posts to (only this port). */
const PORT = 3649;

/** A database that cannot be reached: every query fails. */
function unreachablePrisma(): PrismaService {
  const fail = async (): Promise<never> => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:3306');
  };
  const errorEvent = { deleteMany: fail, findMany: fail, updateMany: fail, fields: { notifiedAt: 'notifiedAt' } };
  return { client: { errorEvent } } as unknown as PrismaService;
}

function config(values: Record<string, string | undefined>): ConfigService<Env, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

describe('error digest: alerts the fallback file when the database is down (PLAT-31)', () => {
  let dir: string;
  let file: string;
  let posts: string[];
  let server: Server;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        posts.push((JSON.parse(body) as { text: string }).text);
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'erp-digest-'));
    file = path.join(dir, 'errors-fallback.log');
    posts = [];
    const line = (fingerprint: string, name: string, count: number, p: string) =>
      JSON.stringify({
        at: '2026-11-13T10:00:00.000Z',
        source: 'API',
        name,
        message: 'redacted message',
        method: 'GET',
        path: p,
        status: 500,
        tenantId: '7',
        userId: null,
        requestId: null,
        fingerprint,
        count,
        dbError: 'connect ECONNREFUSED 127.0.0.1:3306',
      });
    await writeFile(
      file,
      [
        line('fp-a', 'PrismaClientKnownRequestError', 1, '/api/v1/invoices'),
        line('fp-a', 'PrismaClientKnownRequestError', 2, '/api/v1/invoices'),
        line('fp-b', 'TypeError', 1, '/api/v1/items'),
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('posts the fallback count, rotates the file to .1, and reports ok false', async () => {
    const service = new ErrorDigestService(
      unreachablePrisma(),
      config({ ERROR_LOG_FILE: file, ALERT_WEBHOOK_URL: `http://127.0.0.1:${PORT}/hook` }),
    );

    const run = await service.run(new Date('2026-11-13T11:00:00Z'));

    expect(run).toMatchObject({ sent: true, reason: null, pending: 0, fallback: 3, ok: false, pruned: 0 });
    expect(run.dbError).toContain('ECONNREFUSED');

    expect(posts).toHaveLength(1);
    const text = posts[0];
    expect(text).toContain('3 error(s) could not be written to the database (fallback log errors-fallback.log)');
    // Grouped by fingerprint: the first kind counts both its lines.
    expect(text).toContain('• [API] PrismaClientKnownRequestError ×3 (/api/v1/invoices)');
    expect(text).toContain('• [API] TypeError ×1 (/api/v1/items)');
    expect(text).toContain('Database unreachable for the digest: connect ECONNREFUSED');
    expect(text).not.toContain('redacted message');

    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(`${file}.1`, 'utf8')).toContain('fp-a');
  });

  it('does not alert the same fallback lines twice', async () => {
    const service = new ErrorDigestService(
      unreachablePrisma(),
      config({ ERROR_LOG_FILE: file, ALERT_WEBHOOK_URL: `http://127.0.0.1:${PORT}/hook` }),
    );
    await service.run();

    const second = await service.run();

    expect(second).toMatchObject({ fallback: 0, ok: false });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('Database unreachable for the digest');
    expect(posts[1]).not.toContain('could not be written');
  });

  it('without a webhook URL, says why nothing was sent and keeps the file', async () => {
    const service = new ErrorDigestService(unreachablePrisma(), config({ ERROR_LOG_FILE: file }));

    const run = await service.run();

    expect(run).toMatchObject({ sent: false, reason: 'ALERT_WEBHOOK_URL is not set', fallback: 3, ok: false });
    expect(posts).toHaveLength(0);
    // Claimed for the next run, which alerts it before any newer line.
    expect(await readFile(`${file}.alerting`, 'utf8')).toContain('fp-b');
  });

  it('lines written after an unsent claim join it: the next run counts both, then posts them once', async () => {
    const withoutUrl = new ErrorDigestService(unreachablePrisma(), config({ ERROR_LOG_FILE: file }));
    await withoutUrl.run();
    const newer = JSON.stringify({ at: '2026-11-13T11:00:00.000Z', source: 'JOB', name: 'Later', message: 'm', method: null, path: 'backup', status: null, tenantId: null, userId: null, requestId: null, fingerprint: 'fp-later', count: 1, dbError: 'x' });
    await writeFile(file, `${newer}
`);

    expect(await withoutUrl.run()).toMatchObject({ fallback: 4, sent: false });

    const withUrl = new ErrorDigestService(
      unreachablePrisma(),
      config({ ERROR_LOG_FILE: file, ALERT_WEBHOOK_URL: `http://127.0.0.1:${PORT}/hook` }),
    );
    expect(await withUrl.run()).toMatchObject({ fallback: 4, sent: true });
    expect(posts[0]).toContain('Later');
    expect(await withUrl.run()).toMatchObject({ fallback: 0 });
  });

  it('with nothing pending, no fallback lines and a working database, returns without posting', async () => {
    await rm(file);
    const healthy = {
      client: {
        errorEvent: {
          deleteMany: async () => ({ count: 0 }),
          findMany: async () => [],
          fields: { notifiedAt: 'notifiedAt' },
        },
      },
    } as unknown as PrismaService;
    const service = new ErrorDigestService(healthy, config({ ERROR_LOG_FILE: file, ALERT_WEBHOOK_URL: `http://127.0.0.1:${PORT}/hook` }));

    expect(await service.run()).toEqual({ pending: 0, sent: false, reason: null, pruned: 0, fallback: 0, ok: true, dbError: null });
    expect(posts).toHaveLength(0);
  });
});
