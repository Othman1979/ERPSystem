import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';

/**
 * A random temporary password (12 URL-safe characters) for an invitation or a
 * reset. The user must replace it at first sign-in (User.mustChangePassword).
 */
export function generateTemporaryPassword(): string {
  return randomBytes(9).toString('base64url');
}

/**
 * The writes that put a user on a temporary password (ADR-012): the new hash,
 * a forced change at next sign-in, and every refresh token revoked. Returned
 * unexecuted so callers run them in one transaction with their own audit row.
 * `db` is systemPrisma: users and refresh_tokens are platform-wide.
 */
export function temporaryPasswordWrites(db: PrismaClient, userId: bigint, passwordHash: string, now: Date) {
  return [
    db.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: true, passwordChangedAt: now } }),
    db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
  ] as const;
}
