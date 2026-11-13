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

/** SHA-256 of a raw refresh token: the only form stored in refresh_tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A refresh that loses to a rotation of the same token made less than this
 * long ago gets 401 without revoking the family (ADR-012).
 */
export const ROTATION_GRACE_MS = 10_000;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * `familyId` is the refresh-token family of the session (claim `fid`), so a
   * request can be tied back to its session (switch-tenant, logout-all, PLAT-22).
   */
  async signAccessToken(
    userId: bigint,
    tenantId: bigint | null,
    email: string,
    familyId?: string,
  ): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: userId.toString(),
        tid: tenantId?.toString() ?? null,
        email,
        ...(familyId ? { fid: familyId } : {}),
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

    const accessToken = await this.signAccessToken(userId, tenantId, email, familyId);
    return { accessToken, refreshToken, familyId };
  }

  /**
   * Rotates a refresh token. Reuse of a revoked token revokes the entire
   * family (docs/BUILD_PLAN.md §14.2).
   *
   * The old row is claimed atomically (`updateMany ... revokedAt: null`), so of
   * several concurrent calls with one token exactly one wins (PLAT-03). A
   * caller that loses to a rotation made less than ROTATION_GRACE_MS ago is
   * not treated as reuse: it gets 401 and the family stays alive, because
   * the browser already holds the winner's cookie and its retry succeeds
   * (two tabs refreshing together, or a lost response). Any other use of a
   * revoked token is reuse and revokes the family (ADR-012 §Refresh rotation).
   */
  async rotateRefreshToken(
    rawToken: string,
    meta: { userAgent?: string; ip?: string } = {},
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: bigint;
    email: string;
    tenantId: bigint | null;
  } | null> {
    const tokenHash = hashToken(rawToken);
    // systemPrisma: refresh_tokens is platform-global.
    const existing = await this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!existing || existing.expiresAt < new Date()) return null;

    // PLAT-16: a missing or inactive user ends the session before any rotation.
    // The token is revoked so a later retry fails at once.
    // systemPrisma: users is a platform-global table.
    const user = await this.prisma.client.user.findUnique({
      where: { id: existing.userId },
      select: { id: true, email: true, isActive: true },
    });
    if (!user?.isActive) {
      await this.prisma.client.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    const newRefresh = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });

    const rotated = await this.prisma.client.$transaction(async (tx) => {
      const now = new Date();
      const claim = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (claim.count !== 1) return false;
      const row = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tenantId: existing.tenantId,
          tokenHash: hashToken(newRefresh),
          familyId: existing.familyId,
          expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
          ip: meta.ip ?? null,
        },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { replacedById: row.id },
      });
      return true;
    });

    if (!rotated) {
      // Lost the claim: read the committed revocation to tell a concurrent
      // rotation (grace) from real reuse.
      const current = await this.prisma.client.refreshToken.findUnique({
        where: { id: existing.id },
        select: { revokedAt: true, replacedById: true },
      });
      const inGrace =
        current?.revokedAt != null &&
        current.replacedById !== null &&
        Date.now() - current.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (!inGrace) {
        // Token reuse detected — revoke the whole family.
        await this.prisma.client.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return null;
    }

    const accessToken = await this.signAccessToken(
      user.id,
      existing.tenantId,
      user.email,
      existing.familyId,
    );
    return {
      accessToken,
      refreshToken: newRefresh,
      userId: user.id,
      email: user.email,
      tenantId: existing.tenantId,
    };
  }

  async revokeToken(rawToken: string): Promise<void> {
    await this.prisma.client.refreshToken.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Ends one session: every live refresh token of its family. Returns the count. */
  async revokeFamily(familyId: string, userId: bigint): Promise<number> {
    // systemPrisma: refresh_tokens is platform-global.
    const result = await this.prisma.client.refreshToken.updateMany({
      where: { familyId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  /** Ends every session of the user (logout-all). Returns the count. */
  async revokeAllForUser(userId: bigint): Promise<number> {
    // systemPrisma: refresh_tokens is platform-global.
    const result = await this.prisma.client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
