import { Injectable, Logger } from '@nestjs/common';
import { clip, fingerprint, MESSAGE_MAX, pathOnly, redact, STACK_MAX } from '../../common/errors/error-events.util.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type ErrorSourceName = 'API' | 'WEB' | 'JOB';

export interface ErrorOccurrence {
  source: ErrorSourceName;
  /** The thrown value, or the parts a browser reported. */
  error: unknown;
  method?: string | null;
  /** Request path or page URL; the query string is dropped. */
  path?: string | null;
  status?: number | null;
  tenantId?: bigint | null;
  userId?: bigint | null;
  requestId?: string | null;
}

/** Writes per kind of error per window; beyond that occurrences are only counted. */
const WRITES_PER_WINDOW = 5;
const WINDOW_MS = 10_000;
/** Kinds tracked in memory at once (a flood of distinct errors cannot grow it forever). */
const TRACKED_MAX = 1_000;

/** name / message / stack of anything thrown, redacted and cut to the columns. */
export function describeError(error: unknown): { name: string; message: string; stack: string | null } {
  let e: { name: string; message: string; stack: string | null };
  if (error instanceof Error) {
    e = { name: error.name, message: error.message, stack: error.stack ?? null };
  } else if (typeof error === 'object' && error !== null && 'message' in error) {
    // What a browser reports: { name?, message, stack? }.
    const r = error as { name?: unknown; message: unknown; stack?: unknown };
    e = { name: String(r.name ?? 'Error'), message: String(r.message), stack: r.stack ? String(r.stack) : null };
  } else {
    e = { name: 'Error', message: String(error), stack: null };
  }
  return {
    name: clip(redact(e.name || 'Error'), 191),
    message: clip(redact(e.message || '(no message)'), MESSAGE_MAX),
    stack: e.stack ? clip(redact(e.stack), STACK_MAX) : null,
  };
}

/**
 * Records errors for the platform console (ADR-010 §10.3): one row per kind
 * of error, counted; a new occurrence reopens a resolved one. Never throws:
 * a recorder that fails must not hide the error being recorded.
 *
 * A failing hot path must not add a database write per request on top of
 * the incident: each kind is written at most WRITES_PER_WINDOW times per
 * WINDOW_MS; occurrences beyond that are counted here and added to the
 * next write (a process that stops first loses only that count).
 *
 * systemPrisma: a platform table across tenants (allowed in `platform`).
 */
@Injectable()
export class ErrorEventsService {
  private readonly logger = new Logger(ErrorEventsService.name);
  private readonly windows = new Map<string, { start: number; writes: number; skipped: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async record(o: ErrorOccurrence): Promise<void> {
    try {
      const { name, message, stack } = describeError(o.error);
      const fp = fingerprint(o.source, name, message, stack);
      const extra = this.admit(fp, Date.now());
      if (extra === null) return;

      const now = new Date();
      const last = {
        message,
        stack,
        method: o.method ? clip(o.method, 10) : null,
        path: pathOnly(o.path ?? undefined),
        status: o.status ?? null,
        tenantId: o.tenantId ?? null,
        userId: o.userId ?? null,
        requestId: o.requestId ? clip(o.requestId, 64) : null,
        lastSeenAt: now,
      };
      const db = this.prisma.client;
      const update = { ...last, count: { increment: 1 + extra }, resolvedAt: null };
      try {
        await db.errorEvent.upsert({
          where: { fingerprint: fp },
          create: { ...last, fingerprint: fp, source: o.source, name, count: 1 + extra, firstSeenAt: now },
          update,
        });
      } catch (err) {
        // Two first occurrences at once: the other one created the row.
        if ((err as { code?: string }).code !== 'P2002') throw err;
        await db.errorEvent.update({ where: { fingerprint: fp }, data: update });
      }
    } catch (err) {
      this.logger.warn(`Could not record an error: ${err instanceof Error ? redact(err.message.split('\n')[0]) : String(err)}`);
    }
  }

  /**
   * Whether this occurrence is written now: null = only counted; otherwise
   * how many counted-only occurrences to add with it.
   */
  private admit(fp: string, now: number): number | null {
    let w = this.windows.get(fp);
    if (!w || now - w.start >= WINDOW_MS) {
      if (!w && this.windows.size >= TRACKED_MAX) this.windows.clear();
      const carried = w?.skipped ?? 0;
      w = { start: now, writes: 0, skipped: 0 };
      this.windows.set(fp, w);
      w.writes += 1;
      return carried;
    }
    if (w.writes >= WRITES_PER_WINDOW) {
      w.skipped += 1;
      return null;
    }
    w.writes += 1;
    const carried = w.skipped;
    w.skipped = 0;
    return carried;
  }
}
