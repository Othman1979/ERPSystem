import { Injectable } from '@nestjs/common';

/** Failed sign-ins for one email that are allowed before a delay starts. */
export const FREE_FAILURES = 5;
/** Delay after the first delayed failure; doubles with each further failure. */
export const BASE_DELAY_MS = 30_000;
/** Longest delay a sign-in can be held back. */
export const MAX_DELAY_MS = 15 * 60_000;
/** A quiet period this long clears an email's failures. */
export const FORGET_AFTER_MS = 24 * 3_600_000;
/** Upper bound on tracked emails, so a flood of distinct emails cannot grow memory. */
export const MAX_TRACKED = 10_000;

interface Entry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

function keyOf(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Escalating per-email delay for failed sign-ins (owner decision). In memory:
 * each API instance counts on its own, which is the same limit as ADR-011
 * (a shared store comes with a multi-instance deployment).
 */
@Injectable()
export class LoginLockoutService {
  private readonly entries = new Map<string, Entry>();

  /** Counts a failure; returns the delay it starts in ms (0 while still under FREE_FAILURES). */
  fail(email: string, now = Date.now()): number {
    const key = keyOf(email);
    let entry = this.entries.get(key);
    if (entry && now - entry.lastFailureAt > FORGET_AFTER_MS) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      this.makeRoom(now);
      entry = { failures: 0, lastFailureAt: now, lockedUntil: 0 };
      this.entries.set(key, entry);
    }

    entry.failures += 1;
    entry.lastFailureAt = now;
    if (entry.failures >= FREE_FAILURES) {
      const delay = Math.min(BASE_DELAY_MS * 2 ** (entry.failures - FREE_FAILURES), MAX_DELAY_MS);
      entry.lockedUntil = now + delay;
      return delay;
    }
    return 0;
  }

  /** Milliseconds until this email may sign in again; 0 when it may. */
  retryAfterMs(email: string, now = Date.now()): number {
    const key = keyOf(email);
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (now - entry.lastFailureAt > FORGET_AFTER_MS) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, entry.lockedUntil - now);
  }

  /** A successful sign-in clears this email's failures. */
  succeed(email: string): void {
    this.entries.delete(keyOf(email));
  }

  /** Frees a slot for a new email: forgotten entries first, then the oldest inserted. */
  private makeRoom(now: number): void {
    if (this.entries.size < MAX_TRACKED) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastFailureAt > FORGET_AFTER_MS) this.entries.delete(key);
    }
    while (this.entries.size >= MAX_TRACKED) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
