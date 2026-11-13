import { ArgumentMetadata } from '@nestjs/common';
import { DocumentSizePipe, MAX_DOCUMENT_LINES } from './document-size.pipe.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

const body: ArgumentMetadata = { type: 'body' };
const query: ArgumentMetadata = { type: 'query', data: 'lines' };

const lines = (n: number): Array<{ itemId: string }> => Array.from({ length: n }, (_, i) => ({ itemId: String(i + 1) }));

describe('DocumentSizePipe: at most 500 lines per document', () => {
  const pipe = new DocumentSizePipe();

  it('exposes the limit as 500', () => {
    expect(MAX_DOCUMENT_LINES).toBe(500);
  });

  it('refuses 501 lines with DOCUMENT_TOO_MANY_LINES and the counts in details', () => {
    const value = { lines: lines(501) };
    try {
      pipe.transform(value, body);
      throw new Error('expected a DomainError');
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      const e = err as DomainError;
      expect(e.code).toBe(ErrorCode.DOCUMENT_TOO_MANY_LINES);
      expect(e.message).toBe('A document may have at most 500 lines');
      expect(e.details).toEqual({ max: 500, lines: 501 });
    }
  });

  it('accepts exactly 500 lines and returns the body unchanged', () => {
    const value = { lines: lines(500) };
    expect(pipe.transform(value, body)).toBe(value);
  });

  it('ignores a query value named lines, even a long one', () => {
    const value = lines(600) as unknown;
    expect(pipe.transform(value, query)).toBe(value);
  });

  it('ignores a non-object body (array, string, null)', () => {
    expect(pipe.transform(lines(600), body)).toEqual(lines(600));
    expect(pipe.transform('lines', body)).toBe('lines');
    expect(pipe.transform(null, body)).toBeNull();
  });

  it('ignores a body without a lines array', () => {
    const value = { lines: 'not-an-array', name: 'x' };
    expect(pipe.transform(value, body)).toBe(value);
    const noLines = { name: 'x' };
    expect(pipe.transform(noLines, body)).toBe(noLines);
  });
});
