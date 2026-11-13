import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import { catchError, defer, mergeMap, Observable, of } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { REQUIRES_IDEMPOTENCY_KEY } from './requires-idempotency-key.decorator.js';

const KEY_TTL_MS = 24 * 60 * 60 * 1000;
/** 1 to 128 visible ASCII characters (PLAT-17). */
const KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;
// A reservation that loses the race may find the winner's row already
// released (the winner failed); it then tries again a bounded number of times.
const RESERVE_ATTEMPTS = 3;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * Enforces Idempotency-Key on handlers marked @RequiresIdempotencyKey()
 * (docs/BUILD_PLAN.md §10.3). The rule follows the matched route, so a
 * trailing slash or another letter case cannot skip it. Registered BEFORE
 * SerializeInterceptor so the stored responseJson is the final payload.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const required = this.reflector.get<boolean>(REQUIRES_IDEMPOTENCY_KEY, context.getHandler());
    if (!required) return next.handle();

    const request = context.switchToHttp().getRequest<{
      method: string;
      path?: string;
      url: string;
      route?: { path?: string };
      params?: Record<string, string>;
      body?: unknown;
      headers: Record<string, string | string[] | undefined>;
    }>();

    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const rawKey = request.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!tenantId || !key) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        'Idempotency-Key header is required for this endpoint',
      );
    }
    if (!KEY_PATTERN.test(key)) {
      throw new DomainError(
        ErrorCode.VALIDATION,
        'Idempotency-Key must be 1 to 128 visible ASCII characters',
      );
    }

    // Canonical identity of the request: the route pattern plus its params,
    // not the raw URL, so `/5/post/` and `/5/POST` hash like `/5/post`.
    const endpoint = request.route?.path ?? request.path ?? request.url.split('?')[0] ?? '';
    const requestHash = createHash('sha256')
      .update(
        stableStringify({
          method: request.method,
          endpoint,
          params: request.params ?? {},
          body: request.body ?? null,
        }),
      )
      .digest('hex');

    const prisma = this.prisma.forTenant(tenantId);

    const reserve = async (): Promise<{ replay: unknown }> => {
      for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
        try {
          // Atomic reservation: the unique (tenant_id, key) decides the winner.
          await prisma.idempotencyKey.create({
            data: {
              tenantId,
              key,
              endpoint: endpoint.slice(0, 255),
              requestHash,
              status: 'IN_PROGRESS',
              expiresAt: new Date(Date.now() + KEY_TTL_MS),
            },
          });
          return { replay: undefined };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
        const existing = await prisma.idempotencyKey.findFirst({ where: { key } });
        if (!existing) continue; // the holder failed and released it; retry
        if (existing.expiresAt < new Date()) {
          // An expired key is not a conflict: release it and reserve again (PLAT-17).
          await prisma.idempotencyKey.deleteMany({ where: { key, expiresAt: { lt: new Date() } } });
          continue;
        }
        if (existing.requestHash !== requestHash) {
          throw new DomainError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'Idempotency-Key was already used with a different request',
          );
        }
        if (existing.status === 'COMPLETED') return { replay: existing.responseJson };
        throw new DomainError(
          ErrorCode.CONFLICT,
          'A request with this Idempotency-Key is still in progress',
        );
      }
      throw new DomainError(
        ErrorCode.CONFLICT,
        'A request with this Idempotency-Key is still in progress',
      );
    };

    return defer(reserve).pipe(
      mergeMap((pre) => {
        if (pre.replay !== undefined) return of(pre.replay);
        return next.handle().pipe(
          // Only a failed handler releases the key so the client may retry.
          // A failure while recording the result keeps the key reserved: the
          // work may have committed, and a retry must not post twice.
          catchError(async (err) => {
            await prisma.idempotencyKey.deleteMany({ where: { key } }).catch(() => undefined);
            throw err;
          }),
          mergeMap(async (value) => {
            await prisma.idempotencyKey.updateMany({
              where: { key },
              data: {
                status: 'COMPLETED',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                responseJson: value as any,
                httpStatus: 200,
              },
            });
            return value;
          }),
        );
      }),
    );
  }
}
