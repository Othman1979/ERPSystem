import {
  BASE_DELAY_MS,
  FORGET_AFTER_MS,
  LoginLockoutService,
  MAX_DELAY_MS,
  MAX_TRACKED,
} from './login-lockout.service.js';

describe('LoginLockoutService', () => {
  const EMAIL = 'owner@example.test';
  const T0 = 1_000_000_000_000;
  let lockout: LoginLockoutService;

  beforeEach(() => {
    lockout = new LoginLockoutService();
  });

  it('allows the first four failures without a delay', () => {
    for (let i = 0; i < 4; i++) lockout.fail(EMAIL, T0);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(0);
  });

  it('delays from the fifth failure: 30 s, then 60 s', () => {
    for (let i = 0; i < 5; i++) lockout.fail(EMAIL, T0);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(30_000);

    lockout.fail(EMAIL, T0);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(60_000);
  });

  it('counts the delay down with time and frees the email when it passes', () => {
    for (let i = 0; i < 5; i++) lockout.fail(EMAIL, T0);
    expect(lockout.retryAfterMs(EMAIL, T0 + 10_000)).toBe(20_000);
    expect(lockout.retryAfterMs(EMAIL, T0 + 30_000)).toBe(0);
  });

  it('caps the delay at 15 minutes', () => {
    for (let i = 0; i < 30; i++) lockout.fail(EMAIL, T0);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(MAX_DELAY_MS);
    expect(MAX_DELAY_MS).toBe(15 * 60_000);
  });

  it('a successful sign-in resets the failures', () => {
    for (let i = 0; i < 6; i++) lockout.fail(EMAIL, T0);
    lockout.succeed(EMAIL);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(0);

    for (let i = 0; i < 4; i++) lockout.fail(EMAIL, T0);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(0);
  });

  it('ignores case and surrounding spaces in the email', () => {
    for (let i = 0; i < 5; i++) lockout.fail('  Owner@Example.TEST ', T0);
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(BASE_DELAY_MS);
    lockout.succeed('OWNER@example.test ');
    expect(lockout.retryAfterMs(EMAIL, T0)).toBe(0);
  });

  it('forgets an email after 24 hours without a failure', () => {
    for (let i = 0; i < 5; i++) lockout.fail(EMAIL, T0);
    const later = T0 + FORGET_AFTER_MS + 1;
    expect(lockout.retryAfterMs(EMAIL, later)).toBe(0);

    // A new failure after the quiet period starts counting from one again.
    lockout.fail(EMAIL, later);
    expect(lockout.retryAfterMs(EMAIL, later)).toBe(0);
  });

  it('keeps the tracked set within MAX_TRACKED', () => {
    for (let i = 0; i < MAX_TRACKED + 500; i++) {
      lockout.fail(`user-${i}@example.test`, T0);
    }
    const tracked = (lockout as unknown as { entries: Map<string, unknown> }).entries;
    expect(tracked.size).toBe(MAX_TRACKED);
  });

  it('drops the oldest email first when full and nothing is forgotten', () => {
    for (let i = 0; i < MAX_TRACKED; i++) {
      lockout.fail(`user-${i}@example.test`, T0);
    }
    for (let i = 0; i < 5; i++) lockout.fail('first@example.test', T0);
    expect(lockout.retryAfterMs('first@example.test', T0)).toBe(BASE_DELAY_MS);

    lockout.fail('new@example.test', T0);
    // user-0 was the oldest entry; it went away to make room.
    const tracked = (lockout as unknown as { entries: Map<string, unknown> }).entries;
    expect(tracked.has('user-0@example.test')).toBe(false);
    expect(tracked.size).toBe(MAX_TRACKED);
  });
});
