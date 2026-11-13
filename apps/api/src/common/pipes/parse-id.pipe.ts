import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/**
 * A database id in a URL or query: a positive integer of at most 18 digits,
 * so it always fits Prisma's signed 64-bit BigInt (LEDGER-09).
 */
export const ID_PATTERN = /^[1-9]\d{0,17}$/;
/** A money amount as the API accepts it: up to 15 integer digits and 3 decimals, no sign or exponent. */
export const AMOUNT_PATTERN = /^\d{1,15}(\.\d{1,3})?$/;
/** A calendar date, yyyy-mm-dd, with no time or offset (LEDGER-24). */
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `@Param('id', ParseIdPipe) id: string`: a 400 VALIDATION instead of BigInt()'s
 * 500 on "abc". It returns the validated string, so `BigInt(id)` is safe and
 * the OpenAPI parameter (and the generated client) stays a string id.
 */
@Injectable()
export class ParseIdPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      throw new DomainError(ErrorCode.VALIDATION, `${metadata.data ?? 'id'} must be a positive integer id`, {
        field: metadata.data ?? 'id',
      });
    }
    return value;
  }
}
