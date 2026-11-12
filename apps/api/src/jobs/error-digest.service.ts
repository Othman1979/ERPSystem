import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../common/config/env.validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Resolved errors are kept this long, then deleted. */
const RESOLVED_KEEP_DAYS = 90;
/** Errors listed by name in one alert; the rest are counted. */
const LISTED = 10;
const WEBHOOK_TIMEOUT_MS = 10_000;
/** Longest alert text (Discord's limit is 2000 characters). */
const TEXT_MAX = 1_900;

export interface ErrorDigestRun {
  /** Open errors new or seen again since their last alert. */
  pending: number;
  sent: boolean;
  /** Why nothing was sent, when pending > 0. */
  reason: string | null;
  /** Resolved errors older than RESOLVED_KEEP_DAYS, deleted. */
  pruned: number;
}

/**
 * The hourly error alert (ADR-010 §10.3), a Cron command: posts the open
 * errors that are new, or seen again since their last alert, to
 * ALERT_WEBHOOK_URL, then marks them notified. The URL holds a token: it is
 * never printed. A failed post leaves them pending for the next run.
 * systemPrisma: a platform table across tenants (allowed in `jobs`).
 */
@Injectable()
export class ErrorDigestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async run(now = new Date()): Promise<ErrorDigestRun> {
    const db = this.prisma.client;
    const pruned = (
      await db.errorEvent.deleteMany({ where: { resolvedAt: { lt: new Date(now.getTime() - RESOLVED_KEEP_DAYS * DAY_MS) } } })
    ).count;

    const pending = await db.errorEvent.findMany({
      where: {
        resolvedAt: null,
        OR: [{ notifiedAt: null }, { lastSeenAt: { gt: db.errorEvent.fields.notifiedAt } }],
      },
      orderBy: [{ lastSeenAt: 'desc' }],
      select: { id: true, source: true, name: true, path: true, count: true, lastSeenAt: true, tenantId: true },
    });
    if (pending.length === 0) return { pending: 0, sent: false, reason: null, pruned };

    const url = this.config.get('ALERT_WEBHOOK_URL', { infer: true });
    if (!url) return { pending: pending.length, sent: false, reason: 'ALERT_WEBHOOK_URL is not set', pruned };

    // No message text: it may carry tenant data, and the webhook is a third
    // party (ADR-010 §3). The kind, where, how often; the rest is in the console.
    const lines = pending.slice(0, LISTED).map((e) => {
      const where = [e.path, e.tenantId ? `tenant ${e.tenantId}` : null].filter(Boolean).join(', ');
      return `• [${e.source}] ${e.name} ×${e.count}${where ? ` (${where})` : ''}, last ${e.lastSeenAt.toISOString()}`;
    });
    if (pending.length > LISTED) lines.push(`… and ${pending.length - LISTED} more`);
    const full = [`ERP Cloud: ${pending.length} error(s) new or seen again`, ...lines, 'Platform console → Errors'].join('\n');
    // Discord refuses content over 2000 characters; stay under it.
    const text = full.length > TEXT_MAX ? `${full.slice(0, TEXT_MAX - 1)}…` : full;

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

    await db.errorEvent.updateMany({ where: { id: { in: pending.map((e) => e.id) } }, data: { notifiedAt: now } });
    return { pending: pending.length, sent: true, reason: null, pruned };
  }
}
