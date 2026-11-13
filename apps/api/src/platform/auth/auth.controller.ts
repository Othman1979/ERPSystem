import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AllowPendingPasswordChange,
  CurrentUser,
  Public,
  TenantOptional,
} from '../../common/decorators/auth.decorators.js';
import { LimitPerAccount } from '../../common/throttle/throttle.js';
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

function setRefreshCookie(res: Response, token: string, maxAgeDays: number): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: maxAgeDays * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}

const REFRESH_TTL_DAYS = 30;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(dto, meta(req));
    setRefreshCookie(res, result.refreshToken, REFRESH_TTL_DAYS);
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
    setRefreshCookie(res, result.refreshToken, REFRESH_TTL_DAYS);
    const { refreshToken: _rt, familyId: _f, ...body } = result;
    return body;
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta(req));
    setRefreshCookie(res, result.refreshToken, REFRESH_TTL_DAYS);
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
  constructor(private readonly auth: AuthService) {}

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
    setRefreshCookie(res, result.refreshToken, REFRESH_TTL_DAYS);
    const { refreshToken: _rt, familyId: _f, ...body } = result;
    return body;
  }
}
