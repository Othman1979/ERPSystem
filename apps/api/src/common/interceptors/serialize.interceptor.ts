import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { map, Observable } from 'rxjs';

/**
 * Ensures BigInt and Decimal values are serialized as strings in API responses
 * (docs/BUILD_PLAN.md 6.3). Decimal already serializes via toJSON, but this
 * guarantees BigInt never breaks JSON.stringify and keeps decimals as strings.
 */
function serialize(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serialize(data)));
  }
}
