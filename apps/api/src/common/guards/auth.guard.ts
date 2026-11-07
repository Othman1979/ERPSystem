import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

export interface AccessTokenPayload {
  sub: string;
  tid?: string;
  email?: string;
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
      select: { id: true, email: true, isActive: true, isPlatformAdmin: true },
    });
    if (!user || !user.isActive) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'User is inactive or missing');
    }

    const cls = ClsServiceManager.getClsService<RequestContext>();
    cls.set('userId', user.id);
    cls.set('userEmail', user.email);
    cls.set('isPlatformAdmin', user.isPlatformAdmin);
    if (payload.tid) cls.set('tenantId', BigInt(payload.tid));
    return true;
  }
}
