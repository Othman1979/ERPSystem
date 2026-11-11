import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface PlatformAdminGrant {
  email: string;
  isPlatformAdmin: boolean;
  /** false when the user already had that flag (nothing written). */
  changed: boolean;
}

/**
 * Makes a user a platform administrator, or takes it back, from the server's
 * shell (ADR-010 §10.1): the first admin of a fresh installation needs no SQL.
 * Audited with no tenant. systemPrisma: users are platform-wide (allowed in `jobs`).
 */
@Injectable()
export class PlatformAdminGrantService {
  constructor(private readonly prisma: PrismaService) {}

  async set(email: string, isPlatformAdmin: boolean): Promise<PlatformAdminGrant> {
    const db = this.prisma.client;
    const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true, isPlatformAdmin: true } });
    if (!user) throw new Error(`No user with email ${email}`);
    if (user.isPlatformAdmin === isPlatformAdmin) return { email: user.email, isPlatformAdmin, changed: false };
    await db.$transaction([
      db.user.update({ where: { id: user.id }, data: { isPlatformAdmin } }),
      db.auditLog.create({
        data: {
          tenantId: null,
          userId: null,
          action: isPlatformAdmin ? 'platform_admin.grant' : 'platform_admin.revoke',
          entityType: 'user',
          entityId: user.id.toString(),
          beforeJson: { isPlatformAdmin: user.isPlatformAdmin },
          afterJson: { isPlatformAdmin, by: 'cli' },
        },
      }),
    ]);
    return { email: user.email, isPlatformAdmin, changed: true };
  }
}
