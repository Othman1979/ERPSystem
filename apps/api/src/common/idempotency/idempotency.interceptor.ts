import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { catchError, defer, mergeMap, Observable, of } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

// Posting actions (§10.3): /post and /reverse, plus documents that post on
// creation (vouchers, cash transfers) and allocation changes (Phase 6).
const ACTIVITY_PATH = /\/(post|reverse|allocations|cancel)$|\/(receipts|payments|cash-transfers)$/;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Enforces Idempotency-Key on posting actions (see ACTIVITY_PATH)
 * (docs/BUILD_PLAN.md §10.3). Registered BEFORE SerializeInterceptor so the
 * stored responseJson is the final serialized payload.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      path?: string;
      url: string;
      body?: unknown;
      headers: Record<string, string | string[] | undefined>;
    }>();

    const path = request.path ?? request.url.split('?')[0] ?? '';
    if (request.method !== 'POST' || !ACTIVITY_PATH.test(path)) {
      return next.handle();
    }

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

    const requestHash = createHash('sha256')
      .update(stableStringify({ method: request.method, path, body: request.body ?? null }))
      .digest('hex');

    const prisma = this.prisma.forTenant(tenantId);

    return defer(async () => {
      const existing = await prisma.idempotencyKey.findFirst({ where: { key } });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new DomainError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'Idempotency-Key was already used with a different request',
          );
        }
        if (existing.status === 'COMPLETED') {
          return { replay: existing.responseJson };
        }
        throw new DomainError(
          ErrorCode.CONFLICT,
          'A request with this Idempotency-Key is still in progress',
        );
      }
      await prisma.idempotencyKey.create({
        data: {
          tenantId,
          key,
          endpoint: path,
          requestHash,
          status: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + KEY_TTL_MS),
        },
      });
      return { replay: undefined as unknown };
    }).pipe(
      mergeMap((pre) => {
        if (pre.replay !== undefined) return of(pre.replay);
        return next.handle().pipe(
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
          catchError(async (err) => {
            // Failed attempts release the key so the client may retry.
            await prisma.idempotencyKey.deleteMany({ where: { key } }).catch(() => undefined);
            throw err;
          }),
        );
      }),
    );
  }
}
