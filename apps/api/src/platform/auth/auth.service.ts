import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ChartProvisioningService } from '../accounting/chart-provisioning.service.js';
import { LoginDto, RegisterDto, SwitchTenantDto } from './dto/auth.dto.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

const TRIAL_DAYS = 14;

export interface AuthMeta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly provisioning: ChartProvisioningService,
  ) {}

  /**
   * Self-registration: creates tenant (TRIAL) + company + owner user +
   * membership + main branch + trial subscription in ONE transaction
   * (docs/BUILD_PLAN.md §13.4 / Phase 1).
   */
  async register(dto: RegisterDto, meta: AuthMeta) {
    const passwordHash = await this.passwords.hash(dto.password);

    const result = await this.prisma.client.$transaction(async (tx) => {
      // systemPrisma inside tx: registration creates the tenant itself, so no
      // tenant context exists yet — all rows are written with explicit ids.
      const plan = await tx.plan.findFirst({ where: { code: 'TRIAL', isActive: true } });
      const ownerRole = await tx.role.findUnique({ where: { code: 'OWNER' } });
      const jod = await tx.currency.findUnique({ where: { code: 'JOD' } });
      if (!plan || !ownerRole) {
        throw new DomainError(ErrorCode.INTERNAL, 'System is not seeded (plan/roles missing)');
      }

      const existing = await tx.user.findUnique({ where: { email: dto.email } });
      if (existing) {
        throw new DomainError(ErrorCode.CONFLICT, 'Email is already registered');
      }

      const trialEnds = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      const today = new Date();

      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          fullName: dto.ownerName,
          locale: dto.locale ?? 'ar',
        },
      });
      const tenant = await tx.tenant.create({
        data: {
          name: dto.tenantName,
          status: 'TRIAL',
          planId: plan.id,
          trialEndsAt: trialEnds,
        },
      });
      const company = await tx.company.create({
        data: {
          tenantId: tenant.id,
          legalNameAr: dto.companyNameAr ?? dto.tenantName,
          baseCurrencyId: jod?.id ?? null,
        },
      });
      const branch = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          companyId: company.id,
          code: 'MAIN',
          nameAr: 'الفرع الرئيسي',
        },
      });
      await tx.tenantMembership.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          roleId: ownerRole.id,
          status: 'ACTIVE',
          defaultBranchId: branch.id,
        },
      });
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          periodStart: today,
          periodEnd: trialEnds,
          status: 'ACTIVE',
          notes: 'Trial period',
        },
      });

      // Phase 2: default chart of accounts + mappings + lookup defaults.
      await this.provisioning.provision(tx, tenant.id, company.id, user.id);

      return { user, tenant, company, branch };
    });

    // Seed CLS so the audit row carries tenant/user context.
    const cls = ClsServiceManager.getClsService<RequestContext>();
    cls.set('tenantId', result.tenant.id);
    cls.set('userId', result.user.id);
    await this.audit.log({
      action: 'auth.register',
      entityType: 'tenant',
      entityId: result.tenant.id,
      after: { email: dto.email, tenantName: dto.tenantName },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issueSession(result.user.id, result.user.email, result.tenant.id, meta);
  }

  async login(dto: LoginDto, meta: AuthMeta) {
    // systemPrisma: login precedes any tenant context.
    const user = await this.prisma.client.user.findUnique({
      where: { email: dto.email },
      include: {
        memberships: {
          where: { status: 'ACTIVE' },
          include: { tenant: { select: { id: true, name: true, status: true } } },
          orderBy: { id: 'asc' },
        },
      },
    });

    const valid = user ? await this.passwords.verify(user.passwordHash, dto.password) : false;
    if (!user || !valid) {
      await this.audit.log({
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user?.id,
        after: { email: dto.email },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid email or password');
    }

    const wantedTenant = dto.tenantId ? BigInt(dto.tenantId) : null;
    const membership = wantedTenant
      ? user.memberships.find((m) => m.tenantId === wantedTenant)
      : user.memberships[0];
    if (!membership) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'No active membership for this tenant');
    }

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const cls = ClsServiceManager.getClsService<RequestContext>();
    cls.set('tenantId', membership.tenantId);
    cls.set('userId', user.id);
    await this.audit.log({
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issueSession(user.id, user.email, membership.tenantId, meta, {
      tenants: user.memberships.map((m) => ({
        tenantId: m.tenantId.toString(),
        name: m.tenant.name,
        status: m.tenant.status,
      })),
    });
  }

  async refresh(rawToken: string | undefined, meta: AuthMeta) {
    if (!rawToken) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Missing refresh token');
    }
    const rotated = await this.tokens.rotateRefreshToken(rawToken, meta);
    if (!rotated) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid or expired refresh token');
    }
    const user = await this.prisma.client.user.findUnique({
      where: { id: rotated.userId },
      select: { id: true, email: true },
    });
    const accessToken = await this.tokens.signAccessToken(
      rotated.userId,
      rotated.tenantId,
      user?.email ?? '',
    );
    return { accessToken, refreshToken: rotated.refreshToken, user };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.tokens.revokeToken(rawToken);
  }

  async switchTenant(dto: SwitchTenantDto, meta: AuthMeta) {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const userId = cls.get('userId');
    if (!userId) throw new DomainError(ErrorCode.UNAUTHORIZED, 'Not authenticated');
    const tenantId = BigInt(dto.tenantId);

    // systemPrisma: membership check precedes trusting the new tenant.
    const membership = await this.prisma.client.tenantMembership.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      include: { user: { select: { email: true } } },
    });
    if (!membership) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'No active membership for this tenant');
    }

    const tokens = await this.issueSession(userId, membership.user.email, tenantId, meta);
    cls.set('tenantId', tenantId);
    await this.audit.log({
      action: 'auth.switch_tenant',
      entityType: 'tenant',
      entityId: tenantId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return tokens;
  }

  async me() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const userId = cls.get('userId');
    const tenantId = cls.get('tenantId');
    if (!userId) throw new DomainError(ErrorCode.UNAUTHORIZED, 'Not authenticated');

    const [user, memberships] = await Promise.all([
      // systemPrisma: users is platform-global; membership scoping done manually.
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, fullName: true, locale: true, isPlatformAdmin: true },
      }),
      this.prisma.client.tenantMembership.findMany({
        where: { userId, status: 'ACTIVE' },
        include: {
          role: { select: { code: true, nameAr: true, nameEn: true } },
          tenant: {
            select: {
              id: true,
              name: true,
              status: true,
              plan: { select: { code: true, nameAr: true, nameEn: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    if (!user) throw new DomainError(ErrorCode.UNAUTHORIZED, 'User not found');

    const current = memberships.find((m) => m.tenantId === tenantId) ?? null;
    // Branches this member may switch between (ADR-003): assigned ones, or all
    // active branches when none are assigned. Tenant-scoped client.
    let branches: { id: string; code: string; nameAr: string; nameEn: string | null }[] = [];
    if (current) {
      const db = this.prisma.forTenant(current.tenantId);
      const [assigned, active] = await Promise.all([
        db.membershipBranch.findMany({ where: { membershipId: current.id }, select: { branchId: true } }),
        db.branch.findMany({
          where: { isActive: true },
          select: { id: true, code: true, nameAr: true, nameEn: true },
          orderBy: { code: 'asc' },
        }),
      ]);
      const allowed = new Set(assigned.map((a) => a.branchId));
      branches = active
        .filter((b) => allowed.size === 0 || allowed.has(b.id))
        .map((b) => ({ id: b.id.toString(), code: b.code, nameAr: b.nameAr, nameEn: b.nameEn }));
    }
    return {
      user,
      tenants: memberships.map((m) => ({
        tenantId: m.tenantId.toString(),
        tenantName: m.tenant.name,
        status: m.tenant.status,
        roleCode: m.role.code,
        roleNameAr: m.role.nameAr,
        roleNameEn: m.role.nameEn,
        isCurrent: m.tenantId === tenantId,
      })),
      currentTenant: current
        ? {
            tenantId: current.tenant.id.toString(),
            name: current.tenant.name,
            status: current.tenant.status,
            plan: current.tenant.plan,
          }
        : null,
      currentMembership: current
        ? {
            membershipId: current.id.toString(),
            roleCode: current.role.code,
            defaultBranchId: current.defaultBranchId?.toString() ?? null,
            branches,
          }
        : null,
    };
  }

  async myTenants() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const userId = cls.get('userId');
    if (!userId) throw new DomainError(ErrorCode.UNAUTHORIZED, 'Not authenticated');

    const memberships = await this.prisma.client.tenantMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: {
        role: { select: { code: true } },
        tenant: { select: { id: true, name: true, status: true } },
      },
      orderBy: { id: 'asc' },
    });
    return memberships.map((m) => ({
      tenantId: m.tenant.id.toString(),
      name: m.tenant.name,
      status: m.tenant.status,
      roleCode: m.role.code,
    }));
  }

  private async issueSession(
    userId: bigint,
    email: string,
    tenantId: bigint,
    meta: AuthMeta,
    extra: Record<string, unknown> = {},
  ) {
    const tokens = await this.tokens.issueTokens(userId, tenantId, email, meta);
    return { ...tokens, ...extra };
  }
}
