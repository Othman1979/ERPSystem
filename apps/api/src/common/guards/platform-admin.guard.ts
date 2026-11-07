import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { IS_PLATFORM_ADMIN_KEY, IS_PUBLIC_KEY } from '../decorators/auth.decorators.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/** Enforces @PlatformAdmin() — requires User.isPlatformAdmin in CLS. */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ADMIN_KEY, targets);
    if (!required) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const isAdmin =
      ClsServiceManager.getClsService<RequestContext>().get('isPlatformAdmin') === true;
    if (!isAdmin) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Platform administrator access required');
    }
    return true;
  }
}
