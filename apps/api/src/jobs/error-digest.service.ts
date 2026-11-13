import { existsSync } from 'node:fs';
import { appendFile, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.validation.js';
import { errorLine, type FallbackLine, readFallbackLog } from '../platform/monitoring/error-events.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Resolved errors are kept this long, then deleted. */
const RESOLVED_KEEP_DAYS = 90;
/** Open errors not seen again for this long are deleted too: they were alerted and stopped happening (and a flood of one-off reports cannot grow the table forever). */
const STALE_OPEN_DAYS = 30;
/** Errors listed by name in one alert; the rest are counted. */
const LISTED = 10;
/** Kinds listed from the fallback file in one alert. */
const FALLBACK_LISTED = 5;
const WEBHOOK_TIMEOUT_MS = 10_000;
/** Longest alert text (Discord's limit is 2000 characters). */
const TEXT_MAX = 1_900;

export interface ErrorDigestRun {
  /** Open errors new or seen again since their last alert. */
  pending: number;
  sent: boolean;
  /** Why nothing was sent, when there was something to send; or a file that could not be rotated. */
  reason: string | null;
  /** Resolved errors older than RESOLVED_KEEP_DAYS, and open ones not seen for STALE_OPEN_DAYS, deleted. */
  pruned: number;
  /** Occurrences in the fallback file: written there because the database could not take them. */
  fallback: number;
  /** False when the database could not be read or updated: the CLI exits 1, so Cron mail shows an outage. */
  ok: boolean;
  /** The first line of the database error, redacted; null when the database worked. */
  dbError: string | null;
}

interface PendingError {
  id: bigint;
  source: 'API' | 'WEB' | 'JOB';
  name: string;
  path: string | null;
  count: number;
  lastSeenAt: Date;
  tenantId: bigint | null;
}

/**
 * The hourly error alert (ADR-010 §10.3), a Cron command: posts the open
 * errors that are new, or seen again since their last alert, to
 * ALERT_WEBHOOK_URL, then marks them notified. The URL holds a token: it is
 * never printed. A failed post leaves them pending for the next run.
 *
 * It also alerts the fallback file (ERROR_LOG_FILE): occurrences the
 * database could not take during an outage (PLAT-31). That part works with
 * the database down; after a successful post the file is rotated to `.1`
 * so it is not alerted twice.
 * systemPrisma: a platform table across tenants (allowed in `jobs`).
 */
@Injectable()
export class ErrorDigestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async run(now = new Date()): Promise<ErrorDigestRun> {
    const file = path.resolve(this.config.get('ERROR_LOG_FILE', { infer: true }));
    const claimed = await claimFallbackLog(file);
    const fallback = await readFallbackLog(claimed);

    const db = this.prisma.client;
    let pruned = 0;
    let pending: PendingError[] = [];
    let dbError: string | null = null;
    try {
      pruned = (
        await db.errorEvent.deleteMany({
          where: {
            OR: [
              { resolvedAt: { lt: new Date(now.getTime() - RESOLVED_KEEP_DAYS * DAY_MS) } },
              { resolvedAt: null, lastSeenAt: { lt: new Date(now.getTime() - STALE_OPEN_DAYS * DAY_MS) } },
            ],
          },
        })
      ).count;

      pending = await db.errorEvent.findMany({
        where: {
          resolvedAt: null,
          OR: [{ notifiedAt: null }, { lastSeenAt: { gt: db.errorEvent.fields.notifiedAt } }],
        },
        orderBy: [{ lastSeenAt: 'desc' }],
        select: { id: true, source: true, name: true, path: true, count: true, lastSeenAt: true, tenantId: true },
      });
    } catch (err) {
      // The alert still goes out: the outage itself is what someone must hear about.
      dbError = errorLine(err);
    }

    if (pending.length === 0 && fallback.lines.length === 0 && dbError === null) {
      return { pending: 0, sent: false, reason: null, pruned, fallback: 0, ok: true, dbError: null };
    }

    const base = {
      pending: pending.length,
      pruned,
      fallback: fallback.lines.length,
      ok: dbError === null,
      dbError,
    };
    const url = this.config.get('ALERT_WEBHOOK_URL', { infer: true });
    if (!url) return { ...base, sent: false, reason: 'ALERT_WEBHOOK_URL is not set' };

    const text = this.compose(pending, fallback.lines, file, dbError);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` for Slack / Mattermost / Telegram, `content` for Discord.
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      // The URL is a secret: the message names the failure, not the address
      // (the CLI prints messages only; the recorder ignores `cause`).
      throw new Error(`Alert webhook unreachable: ${err instanceof Error ? err.name : 'error'}`, { cause: err });
    }
    if (!res.ok) throw new Error(`Alert webhook answered ${res.status}`);

    // Marked only when the database answered: pending came from it.
    let reason: string | null = null;
    if (pending.length > 0) {
      try {
        await db.errorEvent.updateMany({ where: { id: { in: pending.map((e) => e.id) } }, data: { notifiedAt: now } });
      } catch (err) {
        base.ok = false;
        base.dbError = errorLine(err);
      }
    }
    if (fallback.lines.length > 0) {
      // Only the claimed file was alerted; lines written meanwhile are in a
      // fresh ERROR_LOG_FILE for the next run.
      try {
        await rename(claimed, `${file}.1`);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') reason = `fallback log not rotated: ${errorLine(err)}`;
      }
    }
    return { ...base, sent: true, reason };
  }

  /** The alert text: database errors, fallback occurrences, the database outage. No message text (it may carry tenant data). */
  private compose(pending: PendingError[], fallback: FallbackLine[], file: string, dbError: string | null): string {
    const parts: string[] = [];
    if (pending.length > 0) {
      // The kind, where, how often; the rest is in the console.
      const lines = pending.slice(0, LISTED).map((e) => {
        const where = [e.path, e.tenantId ? `tenant ${e.tenantId}` : null].filter(Boolean).join(', ');
        return `• [${e.source}] ${e.name} ×${e.count}${where ? ` (${where})` : ''}, last ${e.lastSeenAt.toISOString()}`;
      });
      if (pending.length > LISTED) lines.push(`… and ${pending.length - LISTED} more`);
      parts.push(`ERP Cloud: ${pending.length} error(s) new or seen again`, ...lines, 'Platform console → Errors');
    }
    if (fallback.length > 0) {
      const groups = groupByFingerprint(fallback);
      parts.push(
        `ERP Cloud: ${fallback.length} error(s) could not be written to the database (fallback log ${path.basename(file)})`,
      );
      for (const g of groups.slice(0, FALLBACK_LISTED)) {
        parts.push(`• [${g.source}] ${g.name} ×${g.count}${g.path ? ` (${g.path})` : ''}`);
      }
      if (groups.length > FALLBACK_LISTED) parts.push(`… and ${groups.length - FALLBACK_LISTED} more kinds`);
    }
    if (dbError !== null) parts.push(`Database unreachable for the digest: ${dbError}`);

    const full = parts.join('\n');
    // Discord refuses content over 2000 characters; stay under it.
    return full.length > TEXT_MAX ? `${full.slice(0, TEXT_MAX - 1)}…` : full;
  }
}

/**
 * Moves ERROR_LOG_FILE aside to `<file>.alerting` before it is read, so lines
 * the API appends while the alert is being posted go to a fresh file and are
 * alerted by the next run. A claimed file left by a run that posted nothing
 * takes the newer lines in, so nothing is left out of the count.
 */
async function claimFallbackLog(file: string): Promise<string> {
  const claimed = `${file}.alerting`;
  if (!existsSync(claimed)) {
    try {
      await rename(file, claimed);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err;
    }
    return claimed;
  }
  // A claim left by a run that posted nothing (no webhook, or it failed): newer
  // lines join it, so the count always covers every unalerted line.
  try {
    const fresh = await readFile(file);
    await appendFile(claimed, fresh);
    await rm(file);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') throw err;
  }
  return claimed;
}

/** Fallback lines per kind of error, in the order they were first seen. */
function groupByFingerprint(lines: FallbackLine[]): { source: string; name: string; path: string | null; count: number }[] {
  const groups = new Map<string, { source: string; name: string; path: string | null; count: number }>();
  for (const l of lines) {
    const g = groups.get(l.fingerprint);
    if (g) g.count += l.count;
    else groups.set(l.fingerprint, { source: l.source, name: l.name, path: l.path, count: l.count });
  }
  return [...groups.values()];
}
