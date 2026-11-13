import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/** A document (invoice, note, journal entry, ...) may have at most this many lines. */
export const MAX_DOCUMENT_LINES = 500;

/**
 * Refuses a request body whose `lines` array is longer than MAX_DOCUMENT_LINES,
 * before the service builds one row per line. Only the body is checked: a
 * query value named `lines` is ignored, and a non-object body passes through.
 */
@Injectable()
export class DocumentSizePipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body') return value;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;

    const lines = (value as { lines?: unknown }).lines;
    if (Array.isArray(lines) && lines.length > MAX_DOCUMENT_LINES) {
      throw new DomainError(ErrorCode.DOCUMENT_TOO_MANY_LINES, `A document may have at most ${MAX_DOCUMENT_LINES} lines`, {
        max: MAX_DOCUMENT_LINES,
        lines: lines.length,
      });
    }
    return value;
  }
}
