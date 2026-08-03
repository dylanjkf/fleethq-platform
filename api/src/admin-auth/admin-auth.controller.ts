import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { AdminGuarded } from './decorators/admin-guarded.decorator';
import { AdminAuthenticatedOnly } from './decorators/admin-authenticated-only.decorator';
import { AdminSetupExempt } from './decorators/admin-setup-exempt.decorator';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import { AuthenticatedAdminRequestUser } from './admin-jwt-payload.interface';
import { AdminAuthService } from './admin-auth.service';
import { AdminMfaService } from './mfa/admin-mfa.service';
import { AdminLoginDto, AdminMfaVerifyDto } from './dto/admin-login.dto';
import { AdminMfaCodeDto } from './dto/admin-mfa-code.dto';
import { AdminChangePasswordDto } from './dto/admin-change-password.dto';

// Tighter than the app-wide default, matching the customer AuthController's
// posture — these are the credential/code-checking endpoints a brute-force
// attempt against FleetHQ staff accounts would actually hit.
const ADMIN_AUTH_THROTTLE = { default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 10, ttl: 60_000 } };

/**
 * `@Public()` here means "invisible to the customer-facing auth stack", not
 * "unauthenticated" — JwtAuthGuard/PermissionGuard/FeatureGuard are wired
 * globally in AppModule and run on every registered controller, including
 * this one, and `route-permission-coverage.spec.ts` requires every route to
 * carry exactly one customer classification. Marking the whole controller
 * `@Public()` makes the *customer* guards no-op uniformly here (this
 * satisfies that build-time check without pretending these are open routes),
 * while real enforcement is layered on top per-route via
 * `@AdminGuarded()` plus `@AdminAuthenticatedOnly()` /
 * `@RequireAdminPermission()` — a completely separate guard chain, secret,
 * and Passport strategy from the customer stack. `login` and `mfa/verify` are
 * the only two routes that skip the admin guard too — the only genuinely
 * unauthenticated, credential/code-checking entry points into the platform.
 */
@Public()
@Controller({ path: 'admin/auth', version: '1' })
export class AdminAuthController {
  constructor(
    private readonly adminAuth: AdminAuthService,
    private readonly mfa: AdminMfaService,
  ) {}

  @Throttle(ADMIN_AUTH_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: AdminLoginDto, @Ip() ip: string, @Req() req: Request) {
    return this.adminAuth.login(dto.username, dto.password, dto.deviceFingerprint, {
      ip,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @Throttle(ADMIN_AUTH_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  verifyMfa(@Body() dto: AdminMfaVerifyDto, @Ip() ip: string, @Req() req: Request) {
    return this.adminAuth.verifyMfaChallenge(dto.mfaToken, dto.code, dto.rememberDevice ?? false, {
      ip,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt() // identity must be readable so the SPA can learn what to force
  @Get('me')
  getMe(@CurrentAdmin() admin: AuthenticatedAdminRequestUser) {
    return this.adminAuth.getMe(admin.adminUserId);
  }

  /**
   * Change your own password. Reachable during a pending forced reset
   * (@AdminSetupExempt) so an admin flagged mustResetPassword can actually clear
   * it. Returns a fresh access token because the change bumps tokenVersion.
   */
  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt()
  @Throttle(ADMIN_AUTH_THROTTLE)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Body() dto: AdminChangePasswordDto,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.adminAuth.changePassword(admin.adminUserId, admin.sessionId, dto.currentPassword, dto.newPassword, {
      ip,
      userAgent: req.get('user-agent') ?? null,
    });
  }

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt() // listing your own sessions is safe (and useful) during setup
  @Get('sessions')
  listSessions(@CurrentAdmin() admin: AuthenticatedAdminRequestUser) {
    return this.adminAuth.listSessions(admin.adminUserId, admin.sessionId);
  }

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt()
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @CurrentAdmin() admin: AuthenticatedAdminRequestUser,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    await this.adminAuth.revokeOwnSession(admin.adminUserId, sessionId, { ip, userAgent: req.get('user-agent') ?? null });
    return { ok: true };
  }

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt() // always be able to sign out, even mid-setup
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Ip() ip: string, @Req() req: Request) {
    await this.adminAuth.logout(admin.adminUserId, admin.sessionId, { ip, userAgent: req.get('user-agent') ?? null });
    return { ok: true };
  }

  // ── MFA enrolment ─────────────────────────────────────────────────────────

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt() // enrolling MFA is exactly what a forced-MFA obligation requires
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  setupMfa(@CurrentAdmin() admin: AuthenticatedAdminRequestUser) {
    return this.mfa.beginEnrollment(admin.adminUserId);
  }

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @AdminSetupExempt()
  @Throttle(ADMIN_AUTH_THROTTLE)
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  enableMfa(@CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Body() dto: AdminMfaCodeDto, @Ip() ip: string, @Req() req: Request) {
    return this.mfa.confirmEnrollment(admin.adminUserId, dto.code, { ip, userAgent: req.get('user-agent') ?? null });
  }

  @AdminGuarded()
  @AdminAuthenticatedOnly()
  @Throttle(ADMIN_AUTH_THROTTLE)
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(@CurrentAdmin() admin: AuthenticatedAdminRequestUser, @Body() dto: AdminMfaCodeDto, @Ip() ip: string, @Req() req: Request) {
    await this.mfa.disable(admin.adminUserId, dto.code, { ip, userAgent: req.get('user-agent') ?? null });
    return { ok: true };
  }
}
