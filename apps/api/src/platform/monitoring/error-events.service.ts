import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env.validation.js';
import { driverErrno } from '../../common/errors/db-errors.js';
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

/**
 * One line of the fallback file (ERROR_LOG_FILE): an occurrence that could
 * not be written to the database. No stack, no request body: the message is
 * redacted by describeError, the path has no query string.
 */
export interface FallbackLine {
  at: string;
  source: ErrorSourceName;
  name: string;
  message: string;
  method: string | null;
  path: string | null;
  status: number | null;
  tenantId: string | null;
  userId: string | null;
  requestId: string | null;
  fingerprint: string;
  count: number;
  /** The first line of the database error, redacted. */
  dbError: string;
}

/** Writes per kind of error per window; beyond that occurrences are only counted. */
const WRITES_PER_WINDOW = 5;
const WINDOW_MS = 10_000;
/** Kinds tracked in memory at once (a flood of distinct errors cannot grow it forever). */
const TRACKED_MAX = 1_000;
const REASON_MAX = 200;

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

/** The first line of an error's message, redacted and cut: for logs and the fallback file. */
export function errorLine(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // First non-empty line: Prisma's messages start with a newline.
  const first = raw.split('\n').find((l) => l.trim() !== '') ?? '';
  // The driver's errno says more than Prisma's "Invalid `…` invocation" line.
  const errno = driverErrno(err);
  return clip(redact(`${errno !== null ? `errno ${errno}: ` : ''}${first.trim()}`), REASON_MAX);
}

/**
 * The fallback file's lines, oldest first. A missing file is no lines; a
 * line that does not parse is skipped (a half-written line after a crash).
 */
export async function readFallbackLog(file: string): Promise<{ lines: FallbackLine[]; bytes: number }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return { lines: [], bytes: 0 };
    throw err;
  }
  const lines: FallbackLine[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const line = parseFallbackLine(raw);
    if (line) lines.push(line);
  }
  return { lines, bytes: Buffer.byteLength(text, 'utf8') };
}

function parseFallbackLine(raw: string): FallbackLine | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Partial<FallbackLine>;
    if (typeof o.fingerprint !== 'string' || typeof o.source !== 'string' || typeof o.name !== 'string') return null;
    if (typeof o.count !== 'number') return null;
    return o as FallbackLine;
  } catch {
    return null;
  }
}

/**
 * Records errors for the platform console (ADR-010 §10.3): one row per kind
 * of error, counted; a new occurrence reopens a resolved one. Never throws:
 * a recorder that fails must not hide the error being recorded.
 *
 * When the database cannot take the write (full disk, server down), the
 * occurrence is appended to the fallback file (ERROR_LOG_FILE) so the error
 * digest can still alert it (PLAT-31). If that fails too, it goes to stderr.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

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
      const count = 1 + extra;
      const db = this.prisma.client;
      const update = { ...last, count: { increment: count }, resolvedAt: null };
      try {
        try {
          await db.errorEvent.upsert({
            where: { fingerprint: fp },
            create: { ...last, fingerprint: fp, source: o.source, name, count, firstSeenAt: now },
            update,
          });
        } catch (err) {
          // Two first occurrences at once: the other one created the row.
          if ((err as { code?: string }).code !== 'P2002') throw err;
          await db.errorEvent.update({ where: { fingerprint: fp }, data: update });
        }
      } catch (err) {
        await this.spill({
          at: now.toISOString(),
          source: o.source,
          name,
          message,
          method: last.method,
          path: last.path,
          status: last.status,
          tenantId: o.tenantId == null ? null : String(o.tenantId),
          userId: o.userId == null ? null : String(o.userId),
          requestId: last.requestId,
          fingerprint: fp,
          count,
          dbError: errorLine(err),
        });
        throw err;
      }
    } catch (err) {
      this.logger.warn(`Could not record an error: ${errorLine(err)}`);
    }
  }

  /** Appends one line to the fallback file. Never throws: a failed append goes to the log. */
  private async spill(line: FallbackLine): Promise<void> {
    const text = `${JSON.stringify(line)}\n`;
    let file = '';
    try {
      file = path.resolve(this.config.get('ERROR_LOG_FILE', { infer: true }));
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, text, 'utf8');
    } catch (err) {
      this.logger.error(
        `Error not written to the database or the fallback file${file ? ` ${file}` : ''} (${errorLine(err)}): ${text.trimEnd()}`,
      );
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
