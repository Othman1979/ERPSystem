import { Injectable } from '@nestjs/common';
import { PasswordService } from '../platform/auth/password.service.js';
import { generateTemporaryPassword, temporaryPasswordWrites } from '../platform/auth/temporary-password.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PasswordReset {
  email: string;
  /** Shown once, on the server's terminal; it is never written to the audit log. */
  temporaryPassword: string;
  /** Refresh tokens revoked, so every open session of the user is signed out. */
  sessionsRevoked: number;
}

/**
 * Gives a user a temporary password from the server's shell (ADR-012), for
 * when nobody can sign in. The user must change it at next sign-in. Audited
 * with no tenant. systemPrisma: users are platform-wide (allowed in `jobs`).
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
  ) {}

  async run(email: string): Promise<PasswordReset> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) throw new Error(`No user with email ${email}`);

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const now = new Date();
    const [, revoked] = await db.$transaction([
      ...temporaryPasswordWrites(db, user.id, passwordHash, now),
      db.auditLog.create({
        data: {
          tenantId: null,
          userId: null,
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: user.id.toString(),
          afterJson: { by: 'cli' },
        },
      }),
    ]);
    return { email: user.email, temporaryPassword, sessionsRevoked: revoked.count };
  }
}
