import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import {
  ALLOW_PENDING_PASSWORD_CHANGE_KEY,
  IS_PUBLIC_KEY,
} from '../decorators/auth.decorators.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

export interface AccessTokenPayload {
  sub: string;
  tid?: string;
  email?: string;
  /** Issued-at time in whole seconds (added by JwtService). */
  iat?: number;
}

/**
 * Verifies the Bearer access token, loads the user (system client — users are
 * a global table), and seeds the CLS request context.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const header = request.headers['authorization'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token?.startsWith('Bearer ')) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Missing bearer token');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token.slice(7));
    } catch {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid or expired token');
    }

    const userId = BigInt(payload.sub);
    // systemPrisma: users is a platform-global table (no tenant scope).
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        isActive: true,
        isPlatformAdmin: true,
        mustChangePassword: true,
        passwordChangedAt: true,
      },
    });
    if (!user || !user.isActive) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'User is inactive or missing');
    }
    // ADR-012: a password change or reset ends every session at once, not only
    // at the next refresh: access tokens issued before it are refused. JWT `iat`
    // is in whole seconds, so compare in seconds (a token from that same second
    // still passes). The session that changed the password refreshes with its
    // kept cookie through the client's 401 retry.
    if (
      user.passwordChangedAt &&
      typeof payload.iat === 'number' &&
      payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)
    ) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Session ended by a password change');
    }
    // ADR-012: a temporary password allows only the routes that let the user
    // change it (marked @AllowPendingPasswordChange), so the flag cannot be
    // skipped by calling a business route directly.
    if (user.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new DomainError(ErrorCode.PASSWORD_CHANGE_REQUIRED, 'Change your password to continue');
      }
    }

    const cls = ClsServiceManager.getClsService<RequestContext>();
    cls.set('userId', user.id);
    cls.set('userEmail', user.email);
    cls.set('isPlatformAdmin', user.isPlatformAdmin);
    if (payload.tid) cls.set('tenantId', BigInt(payload.tid));
    return true;
  }
}
