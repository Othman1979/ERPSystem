import { JOB_POOL_SIZE } from '../prisma/prisma.service.js';

/**
 * Environment defaults of a one-shot command (jobs/cli.ts), set before the
 * app reads its config. Values already in the environment win over .env, so
 * a Cron command gets a small pool (DB-07) even when .env sizes the API's:
 * the API and the Cron commands that can overlap must stay under the host's
 * max_user_connections (the pool keeps all its connections open). A Cron line
 * can still ask for more: DB_POOL_SIZE=4 node dist/jobs/cli.js ...
 */
export function applyJobEnv(env: NodeJS.ProcessEnv): void {
  // `NAME=` means unset, as in validateEnv.
  if (!env.DB_POOL_SIZE) env.DB_POOL_SIZE = String(JOB_POOL_SIZE);
}
