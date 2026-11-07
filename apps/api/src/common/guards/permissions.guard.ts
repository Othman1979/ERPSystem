import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { REQUIRED_PERMISSIONS_KEY } from '../decorators/auth.decorators.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/** Enforces @RequirePermission(...) codes against the CLS permission set. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const permissions =
      ClsServiceManager.getClsService<RequestContext>().get('permissions') ??
      new Set<string>();
    const ok = required.some((code) => permissions.has(code));
    if (!ok) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        `Missing permission: ${required.join(' | ')}`,
      );
    }
    return true;
  }
}
