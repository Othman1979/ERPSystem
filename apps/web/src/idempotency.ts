/**
 * /post and /reverse endpoints require an Idempotency-Key header
 * (docs/BUILD_PLAN.md §10.3). Generate a fresh UUID per user action —
 * retries of the SAME action should reuse the key, new actions get new keys.
 */
export function idemHeaders(): Record<string, string> {
  return { 'Idempotency-Key': crypto.randomUUID() };
}
