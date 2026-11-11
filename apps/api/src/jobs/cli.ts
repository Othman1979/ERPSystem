import { NestFactory } from '@nestjs/core';
import { JobsModule } from './jobs.module.js';
import { TenantStatusService } from './tenant-status.service.js';

/**
 * One-shot job runner for Cron: `node dist/jobs/cli.js <job>`.
 *   tenant-status  daily subscription lifecycle (ADR-009)
 * Prints the run summary as JSON; exits 1 on failure so Cron mail shows it.
 */
const JOBS: Record<string, (app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>) => Promise<unknown>> = {
  'tenant-status': (app) => app.get(TenantStatusService).run(),
};

async function main(): Promise<void> {
  const name = process.argv[2] ?? '';
  const job = JOBS[name];
  if (!job) {
    console.error(`Unknown job "${name}". Jobs: ${Object.keys(JOBS).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const app = await NestFactory.createApplicationContext(JobsModule, { logger: ['error', 'warn'] });
  try {
    const result = await job(app);
    console.log(JSON.stringify({ job: name, ...(result as object) }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
