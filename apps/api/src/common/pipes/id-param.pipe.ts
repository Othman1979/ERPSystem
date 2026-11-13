import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/**
 * Route params that look like ids: `id`, or a name ending in `Id`
 * (`membershipId`, `lineId`, `itemId`). Every such param in the controllers is
 * a numeric id that the controller passes to BigInt().
 */
const ID_PARAM_NAME = /^(id|[a-z][A-Za-z0-9]*Id)$/;

/** Digits only, at most 19 of them: fits a signed 64-bit BIGINT key. */
const DECIMAL_ID = /^\d{1,19}$/;
const MAX_ID = 9223372036854775807n;

/**
 * Rejects a malformed numeric id in a route param before it reaches BigInt()
 * (which would otherwise throw a SyntaxError and answer 500 in the old filter).
 * A malformed id is a client error: VALIDATION (400), as the ledger contract
 * says (LEDGER-09). A well-formed id that is unknown or another tenant's still
 * reaches the service and answers NOT_FOUND (404).
 *
 * Only route params are checked: body and query values pass through untouched.
 */
@Injectable()
export class IdParamPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'param' || typeof value !== 'string') return value;
    if (!metadata.data || !ID_PARAM_NAME.test(metadata.data)) return value;

    if (!DECIMAL_ID.test(value) || BigInt(value) > MAX_ID) {
      throw new DomainError(ErrorCode.VALIDATION, 'Invalid id', { id: value.slice(0, 32) });
    }
    return value;
  }
}
