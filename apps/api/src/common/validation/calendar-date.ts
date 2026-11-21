import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

export function calendarDate(value: string, field: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new DomainError(ErrorCode.VALIDATION, `${field} is not a calendar date`, { field });
  }
  return date;
}
