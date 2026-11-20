import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { IS_PUBLIC_KEY, TENANT_OPTIONAL_KEY } from '../decorators/auth.decorators.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/**
 * CompanyGuard (ADR-040 §1). Runs after TenantGuard and before BranchGuard, and resolves the
 * company of the request into CLS:
 *  - allowed companies = the member's membership_companies among the tenant's active companies;
 *    none assigned, or the owner, means every active company;
 *  - `X-Company-Id` picks the company and must be allowed, otherwise 403 COMPANY_NOT_ALLOWED;
 *  - without the header: the first allowed company by id (the single company of older tenants).
 */
@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(TENANT_OPTIONAL_KEY, targets)
    ) {
      return true;
    }
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const membershipId = cls.get('membershipId');
    if (tenantId === undefined || membershipId === undefined) return true;

    const db = this.prisma.forTenant(tenantId);
    const [active, assigned] = await Promise.all([
      db.company.findMany({ where: { isActive: true }, orderBy: { id: 'asc' }, select: { id: true } }),
      cls.get('roleCode') === 'OWNER'
        ? Promise.resolve([])
        : db.membershipCompany.findMany({ where: { membershipId }, select: { companyId: true } }),
    ]);
    const restricted = new Set(assigned.map((a) => a.companyId));
    const allowed = active.map((c) => c.id).filter((id) => restricted.size === 0 || restricted.has(id));
    if (allowed.length === 0) {
      throw new DomainError(ErrorCode.COMPANY_NOT_ALLOWED, 'No active company is available to this user');
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const raw = request.headers['x-company-id'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    let companyId = allowed[0]!;
    if (header) {
      if (!/^\d+$/.test(header)) {
        throw new DomainError(ErrorCode.VALIDATION, 'X-Company-Id must be a numeric id');
      }
      const requested = BigInt(header);
      if (!allowed.includes(requested)) {
        throw new DomainError(ErrorCode.COMPANY_NOT_ALLOWED, `Company ${header} is not allowed for this user`);
      }
      companyId = requested;
    }
    cls.set('companyId', companyId);
    return true;
  }
}
