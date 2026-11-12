import { createHash } from 'node:crypto';

/** Longest message and stack kept per error (the table's column sizes). */
export const MESSAGE_MAX = 1000;
export const STACK_MAX = 8000;

/**
 * Secrets that may sit in an error message or stack: values after a
 * password / token / secret / key / authorization name, Bearer tokens and
 * JWT-looking strings. Replaced before anything is stored or sent (CLAUDE.md:
 * never log passwords, tokens or JoFotara secrets).
 */
const SECRET_PAIR = /\b(password|passwd|pwd|secret|token|api[-_]?key|authorization|client[-_]?secret)\b(["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** user:password@ in connection strings (mysql://app:pw@host/db). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;

export function redact(text: string): string {
  // Tokens first: in "Authorization: Bearer <token>" the name/value rule
  // would take "Bearer" as the value and leave the token.
  return text
    .replace(URL_CREDENTIALS, '$1:[redacted]@')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT, '[redacted-jwt]')
    .replace(SECRET_PAIR, '$1$2[redacted]');
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A request path without its query string (it may carry values). */
export function pathOnly(url: string | undefined): string | null {
  if (!url) return null;
  return clip(url.split('?')[0].split('#')[0], 500);
}

/**
 * One fingerprint per kind of error, so repeats count on one row: the
 * source, the error name, the message with numbers and ids blanked out, and
 * the first stack frame (where it was thrown), without line columns.
 */
export function fingerprint(source: string, name: string, message: string, stack: string | null): string {
  const normalised = message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/\d+/g, '#');
  const frame = (stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('at '))
    ?.replace(/:\d+(?=\)?$)/, '');
  return createHash('sha256').update([source, name, normalised, frame ?? ''].join('\n')).digest('hex');
}
