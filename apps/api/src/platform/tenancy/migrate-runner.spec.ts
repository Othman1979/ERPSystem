import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { jest } from '@jest/globals';
import { runMigrationCommand, type SpawnProcess } from './migrate-runner.js';

describe('runMigrationCommand', () => {
  it('keeps the database URL out of argv and passes it through the child environment', async () => {
    const child = new EventEmitter() as ChildProcess;
    const spawnProcess = jest.fn<SpawnProcess>((_command, _args, _options) => child);
    const url = 'mysql://tenant-user:secret@db.example.test:3306/tenant_db';

    const running = runMigrationCommand(url, spawnProcess, '/api/node_modules/prisma/build/index.js');
    child.emit('close', 0, null);
    await running;

    const [command, args, options] = spawnProcess.mock.calls[0] as [string, readonly string[], SpawnOptions];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['/api/node_modules/prisma/build/index.js', 'migrate', 'deploy']);
    expect(args.join(' ')).not.toContain(url);
    expect(options.env?.DATABASE_URL).toBe(url);
  });

  it('redacts URLs and passwords from a failed child tail', async () => {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    const url = 'mysql://tenant-user:s%40cret@db.example.test:3306/tenant_db';
    const running = runMigrationCommand(url, () => child, '/api/node_modules/prisma/build/index.js');
    stderr.write(`${'x'.repeat(5000)} failure for ${url}; decoded=s@cret encoded=s%40cret`);
    child.emit('close', 1, null);
    await expect(running).rejects.toThrow(/Prisma migrate deploy failed/);
    await running.catch((error: Error) => {
      expect(error.message).not.toContain(url);
      expect(error.message).not.toContain('s@cret');
      expect(error.message).not.toContain('s%40cret');
      expect(error.message).not.toContain('tenant-user');
      expect(error.message).toContain('failure for');
      expect(error.message.length).toBeLessThan(4200);
    });
    stdout.end();
    stderr.end();
  });
});
