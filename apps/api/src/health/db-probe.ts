import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { driverErrno } from '../common/errors/db-errors.js';
import { clip, redact } from '../common/errors/error-events.util.js';

export type DbProbeResult =
  | { ok: true; ms: number; tmpdir: 'ok' | 'skipped' }
  | { ok: false; ms: number; reason: string };

/** MariaDB's built-in sequence table: an on-disk temp table needs no user table. */
const SEQUENCE_TABLE = 'seq_1_to_20000';
/** ER_NO_SUCH_TABLE. */
const NO_SUCH_TABLE = 1146;
const REASON_MAX = 200;

/** Thrown inside the probe transaction on purpose, so that nothing is ever committed. */
class ProbeRollback extends Error {
  constructor() {
    super('health probe: rolled back on purpose');
    this.name = 'ProbeRollback';
  }
}

/**
 * Whether the database can WRITE and use its temp directory (PLAT-31): a
 * `SELECT 1` answers even when the disk is full, and the error monitor
 * writes to the same database. One interactive transaction writes one row
 * (an ErrorEvent with a `health-probe:` fingerprint) and forces an on-disk
 * temp table, then rolls back: nothing is committed, and no row survives.
 * The whole probe is bounded by `timeoutMs`.
 *
 * systemPrisma: a platform table across tenants; the probe reads no tenant data.
 */
export async function probeDatabase(client: PrismaClient, timeoutMs = 2000): Promise<DbProbeResult> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DbProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, ms: Date.now() - started, reason: `timed out after ${timeoutMs}ms` }),
      timeoutMs,
    );
  });
  // Settles to a result on its own; if the timer wins, the late settle is ignored.
  const probe = runProbe(client, timeoutMs).then(
    (tmpdir): DbProbeResult => ({ ok: true, ms: Date.now() - started, tmpdir }),
    (err: unknown): DbProbeResult => ({ ok: false, ms: Date.now() - started, reason: failureReason(err) }),
  );
  try {
    return await Promise.race([probe, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function runProbe(client: PrismaClient, timeoutMs: number): Promise<'ok' | 'skipped'> {
  let tmpdir: 'ok' | 'skipped' | null = null;
  try {
    // systemPrisma: see probeDatabase.
    await client.$transaction(
      async (tx) => {
        await tx.errorEvent.create({
          data: {
            fingerprint: `health-probe:${randomUUID()}`,
            source: 'API',
            name: 'HealthProbe',
            message: 'probe',
            count: 0,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          },
        });
        try {
          await tx.$queryRawUnsafe(
            `SET STATEMENT tmp_table_size=1024, max_heap_table_size=16384 FOR
             SELECT COUNT(*) AS n FROM (SELECT seq % 5000 AS g FROM ${SEQUENCE_TABLE} GROUP BY g) x`,
          );
          tmpdir = 'ok';
        } catch (err) {
          // No sequence table (MySQL): the write alone is the proof; the temp
          // table cannot be measured. Any other failure is a real one.
          if (!isMissingTable(err)) throw err;
          tmpdir = 'skipped';
        }
        throw new ProbeRollback();
      },
      { timeout: timeoutMs, maxWait: timeoutMs },
    );
    // The callback always throws, so reaching here means nothing ran.
    throw new Error('health probe: transaction committed unexpectedly');
  } catch (err) {
    if (tmpdir !== null && err instanceof ProbeRollback) return tmpdir;
    throw err;
  }
}

function isMissingTable(err: unknown): boolean {
  if (driverErrno(err) === NO_SUCH_TABLE) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes(SEQUENCE_TABLE) && /doesn't exist/.test(message);
}

/** `errno <n>: <first line, redacted>`: never a password or a connection URL. */
function failureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // First non-empty line: Prisma's messages start with a newline.
  const firstLine = raw.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  const errno = driverErrno(err);
  return clip(`errno ${errno ?? 'none'}: ${redact(firstLine)}`, REASON_MAX);
}
