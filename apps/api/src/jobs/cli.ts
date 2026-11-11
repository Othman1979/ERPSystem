import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EInvoiceWorker } from '../platform/einvoice/einvoice-worker.service.js';
import { EInvoiceJobsModule } from './einvoice-jobs.module.js';
import { JobsModule } from './jobs.module.js';
import { TenantPurgeService } from './tenant-purge.service.js';
import { TenantStatusService } from './tenant-status.service.js';

/**
 * One-shot job runner: `node dist/jobs/cli.js <job> [args]`.
 *   tenant-status                        daily Cron: subscription lifecycle (ADR-009 §3)
 *   einvoice-send                        Cron every minute: send the JoFotara outbox (ADR-009 §15)
 *   purge-tenant <id> [--confirm <name>] by hand: delete a cancelled tenant after retention (ADR-009 §14)
 * Prints the result as JSON; exits 1 on failure or refusal so Cron mail shows it.
 */
type Context = Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

/** Sending stops after this, leaving the rest to the next minute's run. */
const SEND_BUDGET_MS = 50_000;

const JOBS: Record<string, { module: Type<unknown>; run: (app: Context, args: string[]) => Promise<unknown> }> = {
  'tenant-status': { module: JobsModule, run: (app) => app.get(TenantStatusService).run() },
  'einvoice-send': {
    module: EInvoiceJobsModule,
    run: async (app) => {
      const worker = app.get(EInvoiceWorker);
      const started = Date.now();
      let claimed = 0;
      let runs = 0;
      for (;;) {
        const n = await worker.tick();
        runs += 1;
        claimed += n;
        if (n === 0 || Date.now() - started > SEND_BUDGET_MS) break;
      }
      return { runs, claimed, ms: Date.now() - started };
    },
  },
  'purge-tenant': {
    module: JobsModule,
    run: async (app, args) => {
      const id = args[0];
      if (!id || !/^\d+$/.test(id)) throw new Error('Usage: purge-tenant <tenantId> [--confirm "<tenant name>"]');
      const at = args.indexOf('--confirm');
      const purge = app.get(TenantPurgeService);
      if (at < 0) return { dryRun: true, ...(await purge.plan(BigInt(id))) };
      return { purged: true, ...(await purge.run(BigInt(id), args[at + 1] ?? '')) };
    },
  },
};

async function main(): Promise<void> {
  const [name = '', ...args] = process.argv.slice(2);
  const job = JOBS[name];
  if (!job) {
    console.error(`Unknown job "${name}". Jobs: ${Object.keys(JOBS).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  // A command never starts the in-process e-invoice loop: it runs once and exits.
  process.env.EINVOICE_WORKER = 'off';
  const app = await NestFactory.createApplicationContext(job.module, { logger: ['error', 'warn'] });
  try {
    const result = await job.run(app, args);
    console.log(JSON.stringify({ job: name, ...(result as object) }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
