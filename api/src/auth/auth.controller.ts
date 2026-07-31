import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { OAuthProvider } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { AuthenticatedOnly } from '../common/decorators/authenticated-only.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthenticatedRequestUser } from './jwt-payload.interface';
import { AuthService } from './auth.service';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthRecoveryService } from './auth-recovery.service';
import { MfaService } from './mfa/mfa.service';
import { LoginDto } from './dto/login.dto';
import { SelectCompanyDto } from './dto/select-company.dto';
import { ForgotPasswordDto, ResendVerificationDto, ResetPasswordDto, VerifyEmailDto } from './dto/password-reset.dto';
import { MfaCodeDto, MfaVerifyDto } from './dto/mfa.dto';
import { MagicLinkConsumeDto, MagicLinkRequestDto } from './dto/magic-link.dto';
import { OAuthLoginDto } from './dto/oauth-login.dto';
import { WebauthnAuthenticateVerifyDto, WebauthnRegisterVerifyDto } from './webauthn/dto/webauthn.dto';

const URL_PROVIDER_TO_ENUM: Record<string, OAuthProvider> = { google: OAuthProvider.GOOGLE, microsoft: OAuthProvider.MICROSOFT };

// Tighter than the app-wide default (see AppModule) — these are the two
// unauthenticated, credential-checking endpoints a brute-force/credential-
// stuffing attempt would actually hit. The e2e suite logs in on nearly every
// test, so the limit is effectively disabled under NODE_ENV=test, same
// convention used for the app-wide default.
const AUTH_THROTTLE = { default: { limit: process.env.NODE_ENV === 'test' ? 100_000 : 10, ttl: 60_000 } };

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessions: AuthSessionsService,
    private readonly recovery: AuthRecoveryService,
    private readonly mfa: MfaService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    return this.authService.login(dto.username, dto.password, dto.deviceFingerprint, dto.rememberMe ?? false, {
      ip,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.id,
    });
  }

  /**
   * Second step for a multi-company user: exchange the short-lived
   * pre-auth token from `login` plus a chosen companyId for a full,
   * company-scoped session token.
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('select-company')
  @HttpCode(HttpStatus.OK)
  selectCompany(@Body() dto: SelectCompanyDto, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    return this.authService.selectCompany(dto.preAuthToken, dto.companyId, {
      ip,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.id,
    });
  }

  /**
   * No @RequirePermission — an authenticated user seeing their own identity
   * and granted permissions isn't gated behind a permission itself, it's what
   * every other permission check in the product is computed from.
   */
  @Get('me')
  @AuthenticatedOnly()
  getMe(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.authService.getMe(user.companyId, user.membershipId);
  }

  /** Which passwordless/social sign-in options the login page should offer. */
  @Public()
  @Get('providers')
  getProviders() {
    return this.authService.getAuthProviders();
  }

  // ── Magic link (passwordless email login) ────────────────────────────────

  /** Always returns `{ ok: true }` regardless of whether the account exists (no enumeration). */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('magic-link/request')
  @HttpCode(HttpStatus.OK)
  async requestMagicLink(@Body() dto: MagicLinkRequestDto) {
    await this.authService.requestMagicLink(dto.identifier);
    return { ok: true };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('magic-link/consume')
  @HttpCode(HttpStatus.OK)
  consumeMagicLink(@Body() dto: MagicLinkConsumeDto, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    return this.authService.consumeMagicLink(dto.token, dto.deviceFingerprint, dto.rememberMe ?? false, {
      ip,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.id,
    });
  }

  // ── Social login ──────────────────────────────────────────────────────────

  /**
   * `idToken` is whatever the provider's own client-side SDK (Google
   * Identity Services, MSAL.js) returned to the browser — verified here
   * against the provider's live JWKS (OidcVerifierService), never trusted
   * as a bare claim. Sign-in only: refuses with NO_LINKED_ACCOUNT if no
   * FleetHQ account matches (see AuthService.loginWithOAuth's doc comment).
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('oauth/:provider/login')
  @HttpCode(HttpStatus.OK)
  loginWithOAuth(@Param('provider') provider: string, @Body() dto: OAuthLoginDto, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    const resolved = URL_PROVIDER_TO_ENUM[provider.toLowerCase()];
    if (!resolved) {
      throw new BadRequestException({ code: 'UNKNOWN_PROVIDER', message: `Unknown sign-in provider "${provider}".` });
    }
    return this.authService.loginWithOAuth(resolved, dto.idToken, dto.deviceFingerprint, dto.rememberMe ?? false, {
      ip,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.id,
    });
  }

  // ── WebAuthn / passkeys ───────────────────────────────────────────────────

  /** Begin enrolling a new passkey (authenticated) — returns options for `navigator.credentials.create()`. */
  @AuthenticatedOnly()
  @Post('webauthn/register/options')
  @HttpCode(HttpStatus.OK)
  beginWebauthnRegistration(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.authService.beginWebauthnRegistration(user.userId);
  }

  @AuthenticatedOnly()
  @Throttle(AUTH_THROTTLE)
  @Post('webauthn/register/verify')
  @HttpCode(HttpStatus.OK)
  async verifyWebauthnRegistration(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: WebauthnRegisterVerifyDto) {
    await this.authService.completeWebauthnRegistration(user.userId, dto.challengeToken, dto.response, dto.deviceLabel);
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Get('webauthn/credentials')
  listWebauthnCredentials(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.authService.listWebauthnCredentials(user.userId);
  }

  @AuthenticatedOnly()
  @Delete('webauthn/credentials/:id')
  @HttpCode(HttpStatus.OK)
  async removeWebauthnCredential(@CurrentUser() user: AuthenticatedRequestUser, @Param('id') id: string) {
    await this.authService.removeWebauthnCredential(user.userId, id);
    return { ok: true };
  }

  /** Begin a usernameless passkey login (public) — no identifier needed; the platform's own credential picker handles it. */
  @Public()
  @Post('webauthn/login/options')
  @HttpCode(HttpStatus.OK)
  beginWebauthnLogin() {
    return this.authService.beginWebauthnLogin();
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('webauthn/login/verify')
  @HttpCode(HttpStatus.OK)
  loginWithWebauthn(@Body() dto: WebauthnAuthenticateVerifyDto, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    return this.authService.loginWithWebauthn(dto.challengeToken, dto.response, { ip, userAgent: req.get('user-agent') ?? null, requestId: req.id });
  }

  /**
   * Start a password reset. Always returns `{ ok: true }` regardless of whether
   * the account exists — the endpoint must not reveal who has an account.
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.recovery.forgotPassword(dto.identifier);
    return { ok: true };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.recovery.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.recovery.verifyEmail(dto.token);
    return { ok: true };
  }

  /** Re-send a verification email. Also always `{ ok: true }` (no enumeration). */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.recovery.resendVerification(dto.identifier);
    return { ok: true };
  }

  // ── Session & device management ──────────────────────────────────────────

  @Get('sessions')
  @AuthenticatedOnly()
  listSessions(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.sessions.listSessions(user.userId, user.sessionId);
  }

  @Delete('sessions/:sessionId')
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @CurrentUser() user: AuthenticatedRequestUser,
    @Param('sessionId') sessionId: string,
    @Ip() ip: string,
    @Req() req: Request & { id?: string },
  ) {
    await this.sessions.revokeSession(user.userId, sessionId, { ip, userAgent: req.get('user-agent') ?? null, requestId: req.id });
    return { ok: true };
  }

  @Post('logout')
  @AuthenticatedOnly()
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: AuthenticatedRequestUser, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    await this.sessions.logout(user.userId, user.companyId, user.sessionId, { ip, userAgent: req.get('user-agent') ?? null, requestId: req.id });
    return { ok: true };
  }

  // ── MFA ───────────────────────────────────────────────────────────────────

  /**
   * Second step of an MFA login: exchange the short-lived challenge token from
   * `login` (status `mfa_required`) plus a TOTP or backup code for a full
   * session. Public + throttled — it's an unauthenticated, code-checking
   * endpoint, the same brute-force surface as login itself.
   */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  verifyMfa(@Body() dto: MfaVerifyDto, @Ip() ip: string, @Req() req: Request & { id?: string }) {
    return this.authService.verifyMfaChallenge(dto.mfaToken, dto.code, dto.rememberDevice ?? false, {
      ip,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.id,
    });
  }

  /** Begin enrolment (authenticated): returns the secret + otpauth URI for the authenticator app. */
  @AuthenticatedOnly()
  @Post('mfa/setup')
  @HttpCode(HttpStatus.OK)
  setupMfa(@CurrentUser() user: AuthenticatedRequestUser) {
    return this.mfa.beginEnrollment(user.userId);
  }

  /** Confirm enrolment with a code — activates MFA and returns one-time backup codes. */
  @AuthenticatedOnly()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  enableMfa(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: MfaCodeDto) {
    return this.mfa.confirmEnrollment(user.userId, dto.code);
  }

  /** Disable MFA — requires a current TOTP or backup code. */
  @AuthenticatedOnly()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(@CurrentUser() user: AuthenticatedRequestUser, @Body() dto: MfaCodeDto) {
    await this.mfa.disable(user.userId, dto.code);
    return { ok: true };
  }
}
