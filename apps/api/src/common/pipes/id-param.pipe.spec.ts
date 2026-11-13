import { ArgumentMetadata } from '@nestjs/common';
import { IdParamPipe } from './id-param.pipe.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

const param = (data: string): ArgumentMetadata => ({ type: 'param', data });

describe('IdParamPipe: numeric route ids', () => {
  const pipe = new IdParamPipe();

  function expectInvalid(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCode.VALIDATION);
      expect((err as DomainError).getStatus()).toBe(400);
      return;
    }
    throw new Error('expected VALIDATION to be thrown');
  }

  it('refuses a non-numeric id with VALIDATION (400, LEDGER-09)', () => {
    expectInvalid(() => pipe.transform('abc', param('id')));
  });

  it('refuses exponent notation and decimals', () => {
    expectInvalid(() => pipe.transform('1e3', param('id')));
    expectInvalid(() => pipe.transform('1.5', param('itemId')));
  });

  it('refuses a 20-digit id (above the signed 64-bit range)', () => {
    expectInvalid(() => pipe.transform('12345678901234567890', param('id')));
  });

  it('refuses 9223372036854775808, one above the maximum', () => {
    expectInvalid(() => pipe.transform('9223372036854775808', param('membershipId')));
  });

  it('accepts the largest 19-digit id unchanged', () => {
    expect(pipe.transform('9223372036854775807', param('id'))).toBe('9223372036854775807');
  });

  it('accepts a valid numeric id and returns it unchanged', () => {
    expect(pipe.transform('42', param('id'))).toBe('42');
    expect(pipe.transform('7', param('lineId'))).toBe('7');
  });

  it('checks every name ending in Id, not only id', () => {
    expectInvalid(() => pipe.transform('x1', param('membershipId')));
  });

  it('leaves a param named code untouched (barcode and plan codes are not numeric)', () => {
    expect(pipe.transform('ABC-123', param('code'))).toBe('ABC-123');
  });

  it('leaves body and query values untouched', () => {
    expect(pipe.transform('abc', { type: 'query', data: 'id' })).toBe('abc');
    expect(pipe.transform('abc', { type: 'body', data: 'id' })).toBe('abc');
    expect(pipe.transform('abc', { type: 'query', data: 'itemId' })).toBe('abc');
  });

  it('leaves a param with no name, or a non-string value, untouched', () => {
    expect(pipe.transform('abc', { type: 'param', data: undefined })).toBe('abc');
    expect(pipe.transform({ id: 'abc' }, param('id'))).toEqual({ id: 'abc' });
  });
});
