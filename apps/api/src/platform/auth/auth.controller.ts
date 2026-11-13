import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AllowPendingPasswordChange,
  CurrentUser,
  Public,
  TenantOptional,
} from '../../common/decorators/auth.decorators.js';
import type { Env } from '../../common/config/env.validation.js';
import { LimitPerAccount, LimitSignup } from '../../common/throttle/throttle.js';
import { AuthService, type AuthMeta } from './auth.service.js';
import { ChangePasswordDto, LoginDto, RegisterDto, SwitchTenantDto } from './dto/auth.dto.js';

const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/api/v1/auth';

function meta(req: Request): AuthMeta {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

/** Cookie settings from config: lifetime from REFRESH_TOKEN_TTL_DAYS, `secure` in production. */
function setRefreshCookie(
  res: Response,
  token: string,
  config: ConfigService<Env, true>,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.get('NODE_ENV', { infer: true }) === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  // Public registration has the strictest limit: 5 a minute and 20 an hour per address (ADR-011).
  @LimitSignup()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(dto, meta(req));
    setRefreshCookie(res, result.refreshToken, this.config);
    const { refreshToken: _rt, familyId: _f, ...body } = result;
    return body;
  }

  @Public()
  // 10 a minute per address and email; 30 a minute per address across emails (ADR-011).
  @LimitPerAccount()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto, meta(req));
    setRefreshCookie(res, result.refreshToken, this.config);
    const { refreshToken: _rt, familyId: _f, ...body } = result;
    return body;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
    setRefreshCookie(res, result.refreshToken, this.config);
    const { refreshToken: _rt, user, ...body } = result;
    return { ...body, user };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
  }

  /**
   * Ends every session of the signed-in user, on every device (PLAT-22). The
   * current session's cookie is cleared too; its access token stays valid until
   * it expires.
   */
  @TenantOptional()
  @AllowPendingPasswordChange()
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(
    @CurrentUser() userId: bigint,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logoutAll(userId, meta(req));
    clearRefreshCookie(res);
  }

  /**
   * Signed-in user changes their own password (ADR-012). Allowed while a
   * temporary password is pending. The refresh cookie is read here because it
   * keeps the current session signed in.
   */
  @TenantOptional()
  @AllowPendingPasswordChange()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() userId: bigint,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(userId, dto, req.cookies?.[REFRESH_COOKIE]);
  }
}

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @TenantOptional()
  @AllowPendingPasswordChange()
  @Get()
  me() {
    return this.auth.me();
  }

  @TenantOptional()
  @AllowPendingPasswordChange()
  @Get('tenants')
  tenants() {
    return this.auth.myTenants();
  }

  @TenantOptional()
  @Post('switch-tenant')
  @HttpCode(200)
  async switchTenant(
    @Body() dto: SwitchTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.switchTenant(dto, meta(req));
    setRefreshCookie(res, result.refreshToken, this.config);
    const { refreshToken: _rt, familyId: _f, ...body } = result;
    return body;
  }
}
