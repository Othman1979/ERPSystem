import { Injectable, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerOptions } from '@nestjs/throttler';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';

/**
 * Request limits (ADR-008). Each window is one minute.
 *
 * - `default`: per signed-in user, otherwise per client address. An office
 *   behind one public address doesn't share one allowance.
 * - `account`: only on routes marked `@LimitPerAccount()` (sign-in): per
 *   address and email, so one person's wrong passwords don't lock out a
 *   colleague at the same address. The route keeps a lower `default` limit
 *   as a cap per address.
 *
 * The client address is `req.ip`, which reads X-Forwarded-For only from the
 * proxies TRUST_PROXY names (main.ts, `trustProxySetting`).
 */
const PER_ACCOUNT = 'throttle:perAccount';

export const LimitPerAccount = () => SetMetadata(PER_ACCOUNT, true);

interface TrackedRequest {
  ip?: string;
  body?: { email?: unknown };
}

export const throttlers: ThrottlerOptions[] = [
  { name: 'default', ttl: 60_000, limit: 100 },
  {
    name: 'account',
    ttl: 60_000,
    limit: 10,
    skipIf: (context) => Reflect.getMetadata(PER_ACCOUNT, context.getHandler()) !== true,
    getTracker: (req: TrackedRequest) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      return `${req.ip ?? ''}|${email}`;
    },
  },
];

/** Counts a signed-in request against its user; runs after AuthGuard, which sets the user. */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId');
    return userId != null ? `user:${userId}` : super.getTracker(req);
  }
}
