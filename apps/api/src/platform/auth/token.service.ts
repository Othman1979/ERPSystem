import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Env } from '../../common/config/env.validation.js';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  familyId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  async signAccessToken(userId: bigint, tenantId: bigint | null, email: string): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: userId.toString(),
        tid: tenantId?.toString() ?? null,
        email,
      },
      {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        expiresIn: this.config.get('ACCESS_TOKEN_TTL', {
          infer: true,
        }) as JwtSignOptions['expiresIn'],
      },
    );
  }

  /** Creates a new refresh-token family for a login. */
  async issueTokens(
    userId: bigint,
    tenantId: bigint | null,
    email: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<IssuedTokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    const familyId = randomUUID();
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });

    // systemPrisma: refresh_tokens is a platform-global table.
    await this.prisma.client.refreshToken.create({
      data: {
        userId,
        tenantId,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
        ip: meta.ip ?? null,
      },
    });

    const accessToken = await this.signAccessToken(userId, tenantId, email);
    return { accessToken, refreshToken, familyId };
  }

  /**
   * Rotates a refresh token. Reuse of a revoked token revokes the entire
   * family (docs/BUILD_PLAN.md §14.2).
   */
  async rotateRefreshToken(
    rawToken: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{ accessToken: string; refreshToken: string; userId: bigint; tenantId: bigint | null } | null> {
    const tokenHash = hashToken(rawToken);
    // systemPrisma: refresh_tokens is platform-global.
    const existing = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!existing || existing.expiresAt < new Date()) return null;

    if (existing.revokedAt !== null) {
      // Token reuse detected — revoke the whole family.
      await this.prisma.client.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    const newRefresh = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });

    await this.prisma.client.$transaction(async (tx) => {
      const row = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tenantId: existing.tenantId,
          tokenHash: hashToken(newRefresh),
          familyId: existing.familyId,
          expiresAt: new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000),
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
          ip: meta.ip ?? null,
        },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedById: row.id },
      });
      return row;
    });

    const user = await this.prisma.client.user.findUnique({
      where: { id: existing.userId },
      select: { id: true, email: true, isActive: true },
    });
    if (!user?.isActive) return null;

    const accessToken = await this.signAccessToken(user.id, existing.tenantId, user.email);
    return {
      accessToken,
      refreshToken: newRefresh,
      userId: user.id,
      tenantId: existing.tenantId,
    };
  }

  async revokeToken(rawToken: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
