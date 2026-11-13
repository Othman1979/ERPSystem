import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Invitation acceptance codes (owner decision, ADR-012 §PLAT-10): an existing
 * user joins a company only with the one-time code its admin handed over in
 * person. Holding the account (or its password) is not enough.
 */

/** Crockford-style alphabet: no I, L, O, U, so a code read aloud is not misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 10 characters of 32 symbols: 50 bits, against at most MAX_ATTEMPTS guesses. */
const LENGTH = 10;
/** How long a code may be used. */
export const CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Wrong codes accepted per issued code; then the admin must issue a new one. */
export const MAX_ATTEMPTS = 5;

/** A new code, shown as `XXXXX-XXXXX`. */
export function generateInvitationCode(): string {
  let raw = '';
  for (let i = 0; i < LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** What the person typed, in canonical form: case, spaces and dashes do not matter. */
export function normaliseInvitationCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** sha256 of the canonical code: the only form stored. */
export function hashInvitationCode(code: string): string {
  return createHash('sha256').update(normaliseInvitationCode(code)).digest('hex');
}

/** Whether `input` is the code whose hash is stored (constant time). */
export function invitationCodeMatches(input: string, storedHash: string): boolean {
  const a = Buffer.from(hashInvitationCode(input), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The columns of a freshly issued code. */
export function issueInvitationCode(now = new Date()): {
  code: string;
  data: { inviteCodeHash: string; inviteCodeExpiresAt: Date; inviteCodeAttempts: number };
} {
  const code = generateInvitationCode();
  return {
    code,
    data: {
      inviteCodeHash: hashInvitationCode(code),
      inviteCodeExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
      inviteCodeAttempts: 0,
    },
  };
}
