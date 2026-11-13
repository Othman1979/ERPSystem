import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import type { Env } from '../../common/config/env.validation.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ChartProvisioningService } from '../accounting/chart-provisioning.service.js';
import { ChangePasswordDto, LoginDto, RegisterDto, SwitchTenantDto } from './dto/auth.dto.js';
import { LoginLockoutService } from './login-lockout.service.js';
import { PasswordService } from './password.service.js';
import { hashToken, TokenService } from './token.service.js';

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
    private readonly config: ConfigService<Env, true>,
    private readonly lockout: LoginLockoutService,
  ) {}

  /**
   * Argon2 hash of random bytes, computed once. An unknown email is verified
   * against it, so a missing account costs the same time as a wrong password (PLAT-16).
   */
  private dummyHash: Promise<string> | null = null;

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(randomBytes(32).toString('base64url'));
    return this.dummyHash;
  }

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

      const trialEnds = new Date(Date.now() + this.config.get('TRIAL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000);
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
          statusChangedAt: today,
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
    // Checked before any lookup, for known and unknown emails alike, so the
    // answer does not reveal whether the account exists (owner decision).
    const wait = this.lockout.retryAfterMs(dto.email);
    if (wait > 0) {
      // Not audited per attempt: an attacker on many addresses would turn the delay
      // into one audit row per request. The failure that starts the delay is audited.
      throw new DomainError(
        ErrorCode.LOGIN_LOCKED,
        'Too many failed sign-ins for this email; try again later',
        { retryAfterSeconds: Math.ceil(wait / 1000) },
      );
    }

    // systemPrisma: login precedes any tenant context.
    const user = await this.prisma.client.user.findUnique({
      where: { email: dto.email },
      include: {
        memberships: {
          where: { status: { in: ['ACTIVE', 'INVITED'] } },
          include: { tenant: { select: { id: true, name: true, status: true } } },
          orderBy: { id: 'asc' },
        },
      },
    });

    // PLAT-16: an unknown email is verified too, so both paths cost the same.
    const matches = await this.passwords.verify(
      user?.passwordHash ?? (await this.getDummyHash()),
      dto.password,
    );
    // An inactive user fails exactly like a wrong password.
    const valid = user !== null && user.isActive && matches;
    if (!user || !valid) {
      const delayMs = this.lockout.fail(dto.email);
      await this.audit.log({
        action: delayMs > 0 ? 'auth.login_locked' : 'auth.login_failed',
        entityType: 'user',
        entityId: user?.id,
        after: delayMs > 0 ? { email: dto.email, lockedForSeconds: Math.ceil(delayMs / 1000) } : { email: dto.email },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'Invalid email or password');
    }
    this.lockout.succeed(dto.email);

    const active = user.memberships.filter((m) => m.status === 'ACTIVE');
    const pendingInvitations = user.memberships.filter((m) => m.status === 'INVITED').length;
    const wantedTenant = dto.tenantId ? BigInt(dto.tenantId) : null;
    const membership = wantedTenant
      ? active.find((m) => m.tenantId === wantedTenant)
      : active[0];
    // Only invitations are waiting: sign in without a company, so the user can
    // see and accept them (GET /me/invitations).
    const withoutTenant = !membership && !wantedTenant && pendingInvitations > 0;
    if (!membership && !withoutTenant) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'No active membership for this tenant');
    }

    await this.prisma.client.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const cls = ClsServiceManager.getClsService<RequestContext>();
    if (membership) cls.set('tenantId', membership.tenantId);
    cls.set('userId', user.id);
    await this.audit.log({
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.issueSession(user.id, user.email, membership?.tenantId ?? null, meta, {
      tenants: active.map((m) => ({
        tenantId: m.tenantId.toString(),
        name: m.tenant.name,
        status: m.tenant.status,
      })),
      pendingInvitations,
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
    return {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      user: { id: rotated.userId, email: rotated.email },
    };
  }

  /**
   * Changes the signed-in user's own password (ADR-012). Ends the user's other
   * sessions: every refresh token outside the caller's own family is revoked,
   * so the session that made the change stays signed in.
   */
  async changePassword(
    userId: bigint,
    dto: ChangePasswordDto,
    rawRefreshCookie: string | undefined,
  ): Promise<void> {
    // systemPrisma: users and refresh_tokens are platform-wide tables.
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new DomainError(ErrorCode.UNAUTHORIZED, 'User not found');

    const matches = await this.passwords.verify(user.passwordHash, dto.currentPassword);
    if (!matches) {
      throw new DomainError(ErrorCode.INVALID_CURRENT_PASSWORD, 'Current password is incorrect');
    }
    if (dto.newPassword === dto.currentPassword) {
      throw new DomainError(ErrorCode.VALIDATION, 'The new password must differ from the current one');
    }

    const newHash = await this.passwords.hash(dto.newPassword);
    const now = new Date();

    await this.prisma.client.$transaction(async (tx) => {
      // The family of the refresh cookie that made this request: that session stays signed in.
      const current = rawRefreshCookie
        ? await tx.refreshToken.findFirst({
            where: { tokenHash: hashToken(rawRefreshCookie), userId },
            select: { familyId: true },
          })
        : null;

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash: newHash,
          mustChangePassword: false,
          passwordChangedAt: now,
        },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(current ? { familyId: { not: current.familyId } } : {}),
        },
        data: { revokedAt: now },
      });
      await tx.auditLog.create({
        data: {
          tenantId: null,
          userId,
          action: 'auth.password_change',
          entityType: 'user',
          entityId: userId.toString(),
          afterJson: { otherSessionsRevoked: revoked.count },
        },
      });
    });
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await this.tokens.revokeToken(rawToken);
  }

  /** Ends every session of the caller on every device (PLAT-22). Returns the revoked count. */
  async logoutAll(userId: bigint, meta: AuthMeta): Promise<number> {
    const revoked = await this.tokens.revokeAllForUser(userId);
    await this.audit.log({
      action: 'auth.logout_all',
      entityType: 'user',
      entityId: userId,
      after: { sessionsRevoked: revoked },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return revoked;
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
    // PLAT-22: switching company ends the session it leaves.
    const previousFamily = cls.get('familyId');
    if (previousFamily) await this.tokens.revokeFamily(previousFamily, userId);
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

    const [user, memberships, pendingInvitations] = await Promise.all([
      // systemPrisma: users is platform-global; membership scoping done manually.
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          locale: true,
          isPlatformAdmin: true,
          mustChangePassword: true,
        },
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
      // systemPrisma: memberships of this user only (count, no tenant data).
      this.prisma.client.tenantMembership.count({ where: { userId, status: 'INVITED' } }),
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
      /** Companies this user was invited to and has not accepted yet. */
      pendingInvitations,
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
    tenantId: bigint | null,
    meta: AuthMeta,
    extra: Record<string, unknown> = {},
  ) {
    const tokens = await this.tokens.issueTokens(userId, tenantId, email, meta);
    return { ...tokens, ...extra };
  }
}
