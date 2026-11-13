import { Injectable, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerOptions } from '@nestjs/throttler';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';

/**
 * Request limits (ADR-011, D-6). Each window is one minute unless noted.
 *
 * - `default`: per signed-in user (300 a minute), otherwise per client address
 *   (100 a minute). An office behind one public address doesn't share one
 *   allowance once its people sign in. Routes may lower it (sign-in, registration).
 * - `account`: only on routes marked `@LimitPerAccount()` (sign-in): per
 *   address and email, so one person's wrong passwords don't lock out a
 *   colleague at the same address. The route keeps a lower `default` limit
 *   as a cap per address.
 * - `signup`: only on routes marked `@LimitSignup()` (registration): 20 an
 *   hour per client address. Public routes never set a user, so the guard
 *   tracks them by address.
 *
 * The client address is `req.ip`, which reads X-Forwarded-For only from the
 * proxies TRUST_PROXY names (main.ts, `trustProxySetting`).
 */
const PER_ACCOUNT = 'throttle:perAccount';
const PER_SIGNUP = 'throttle:signup';

export const LimitPerAccount = () => SetMetadata(PER_ACCOUNT, true);
export const LimitSignup = () => SetMetadata(PER_SIGNUP, true);

interface TrackedRequest {
  ip?: string;
  body?: { email?: unknown };
}

/** The `default` limit a signed-in request gets (D-6); public requests get 100. */
const DEFAULT_LIMIT_SIGNED_IN = 300;
const DEFAULT_LIMIT_ANONYMOUS = 100;

export const throttlers: ThrottlerOptions[] = [
  {
    name: 'default',
    ttl: 60_000,
    limit: () =>
      ClsServiceManager.getClsService<RequestContext>().get('userId') != null
        ? DEFAULT_LIMIT_SIGNED_IN
        : DEFAULT_LIMIT_ANONYMOUS,
  },
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
  {
    name: 'signup',
    ttl: 3_600_000,
    limit: 20,
    skipIf: (context) => Reflect.getMetadata(PER_SIGNUP, context.getHandler()) !== true,
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
