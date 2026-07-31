import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as bcrypt from 'bcrypt';
import { OAuthProvider, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuthTokensService } from './auth-tokens.service';
import { AuthMailService } from './auth-mail.service';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthRecoveryService } from './auth-recovery.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { MfaService } from './mfa/mfa.service';
import { OidcVerifierService } from './oidc-verifier.service';
import { WebauthnService } from './webauthn/webauthn.service';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { JwtPayload, LoginMethod, MfaChallengePayload, PreAuthJwtPayload } from './jwt-payload.interface';

/** Optional request context threaded from the controller for audit records. */
export interface AuthContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface CompanyChoice {
  id: string;
  name: string;
}

export type LoginResult =
  | { status: 'authenticated'; accessToken: string; company: CompanyChoice }
  | { status: 'choose_company'; preAuthToken: string; companies: CompanyChoice[] }
  | { status: 'mfa_required'; mfaToken: string };

const PRE_AUTH_EXPIRES_IN = '5m';
const MFA_CHALLENGE_EXPIRES_IN = '5m';
const SESSION_EXPIRES_IN_MS = 12 * 60 * 60 * 1000; // 12h — matches JWT_EXPIRES_IN's default
const REMEMBER_ME_EXPIRES_IN = '30d';
const REMEMBER_ME_SESSION_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000;
const DUMMY_HASH = '$2b$10$invalidsaltinvalidsaltinvalidsaltuz';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly jwt: JwtService,
    private readonly authTokens: AuthTokensService,
    private readonly mail: AuthMailService,
    private readonly sessions: AuthSessionsService,
    private readonly recovery: AuthRecoveryService,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly oidc: OidcVerifierService,
    private readonly webauthn: WebauthnService,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  /** Which passwordless/social sign-in methods are actually usable right now — drives the login page's UI. */
  getAuthProviders(): { magicLink: true; webauthn: true; google: boolean; microsoft: boolean } {
    return {
      magicLink: true,
      webauthn: true,
      google: this.oidc.isConfigured(OAuthProvider.GOOGLE),
      microsoft: this.oidc.isConfigured(OAuthProvider.MICROSOFT),
    };
  }

  async login(
    username: string,
    password: string,
    deviceFingerprint: string | undefined,
    rememberMe: boolean,
    context: AuthContext = {},
  ): Promise<LoginResult> {
    // `users` has RLS scoped to "shares a company with the requester" (see
    // the users RLS migration) — which doesn't apply yet, since we don't know
    // who's asking. This is the one legitimate use of the narrow, SELECT-only
    // fleetos_auth role rather than the normal tenant-scoped connection.
    const user = await this.systemPrisma.user.findUnique({ where: { username } });

    // Constant-shape response whether the username doesn't exist or the
    // password is wrong, so login can't be used to enumerate usernames.
    const invalidCredentials = (reason: string) => {
      // Security/access history, not business history — deliberately not a
      // TimelineEvent (that's for entity mutations a company can see; a
      // failed login attempt isn't tied to a company yet and isn't the kind
      // of thing Timelines/Fleet_Graph.md's UI is meant to surface).
      this.logger.warn({ event: 'auth.login_failed', username, reason }, 'Login failed');
      void this.audit.recordSystem({
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        outcome: 'failure',
        actorLabel: username,
        ip: context.ip,
        requestId: context.requestId,
        metadata: { reason },
      });
      return new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password.',
      });
    };

    if (!user || user.archivedAt) {
      // Still run a bcrypt compare against a dummy hash so response timing
      // doesn't leak whether the username exists.
      await bcrypt.compare(password, DUMMY_HASH);
      throw invalidCredentials(user ? 'account_archived' : 'unknown_username');
    }

    // Brute-force lock: a locked account is refused without even checking the
    // password (dummy compare keeps timing flat), and the lock clears on its
    // own once the window passes.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw invalidCredentials('account_locked');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      const locked = await this.recordFailedLogin(user.id, user.failedLoginCount);
      if (locked) {
        // Structured event so a CloudWatch metric filter can alarm on a burst of
        // lockouts (credential-stuffing) — see infra/terraform/modules/monitoring.
        this.logger.warn({ event: 'auth.account_locked', username, userId: user.id }, 'Account locked after repeated failures');
        void this.audit.recordSystem({
          action: AUDIT_ACTIONS.LOGIN_LOCKED_OUT,
          outcome: 'failure',
          actorUserId: user.id,
          actorLabel: user.username,
          ip: context.ip,
          requestId: context.requestId,
        });
      }
      throw invalidCredentials('wrong_password');
    }

    // Successful login clears any accumulated failures / lock.
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.systemPrisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    }

    return this.proceedPastFirstFactor(user, deviceFingerprint, rememberMe, 'password', context);
  }

  /**
   * Always resolves to `{ ok: true }` at the controller regardless of whether
   * the account exists or has an email — enumeration-safe, same pattern as
   * forgotPassword/resendVerification.
   */
  async requestMagicLink(identifier: string): Promise<void> {
    const user = await this.recovery.findUserByIdentifier(identifier);
    if (!user || user.archivedAt || !user.email) return;
    const token = await this.authTokens.issue(user.id, 'MAGIC_LINK');
    await this.mail.sendMagicLink(user.email, user.fullName, token);
  }

  /** Passwordless login: a clicked magic link stands in for the password check. */
  async consumeMagicLink(
    token: string,
    deviceFingerprint: string | undefined,
    rememberMe: boolean,
    context: AuthContext = {},
  ): Promise<LoginResult> {
    const userId = await this.authTokens.consume(token, 'MAGIC_LINK');
    if (!userId) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This sign-in link is invalid or has expired.' });
    }
    const user = await this.systemPrisma.user.findUnique({ where: { id: userId } });
    if (!user || user.archivedAt) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This sign-in link is invalid or has expired.' });
    }
    return this.proceedPastFirstFactor(user, deviceFingerprint, rememberMe, 'magic_link', context);
  }

  /**
   * Social login. Sign-IN only — this product has no self-service signup path
   * (CompaniesController's doc comment), so a verified identity with no
   * existing link and no matching account is refused, never used to
   * provision one. First successful login by a given external account
   * auto-links it (by verified email, which must resolve to exactly one
   * active account); every login after that resolves by the stored
   * provider+subject pairing instead, so it keeps working even if the
   * person's email address later changes at the provider.
   */
  async loginWithOAuth(
    provider: OAuthProvider,
    idToken: string,
    deviceFingerprint: string | undefined,
    rememberMe: boolean,
    context: AuthContext = {},
  ): Promise<LoginResult> {
    const identity = await this.oidc.verify(provider, idToken);
    if (!identity.emailVerified) {
      throw new UnauthorizedException({ code: 'EMAIL_NOT_VERIFIED', message: "That account's email address is not verified." });
    }

    const existingLink = await this.systemPrisma.oAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider, providerSubject: identity.subject } },
    });

    let user: User | null;
    if (existingLink) {
      user = await this.systemPrisma.user.findUnique({ where: { id: existingLink.userId } });
      void this.systemPrisma.oAuthIdentity.update({ where: { id: existingLink.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    } else {
      const candidates = await this.systemPrisma.user.findMany({ where: { email: identity.email, archivedAt: null } });
      if (candidates.length === 0) {
        throw new UnauthorizedException({
          code: 'NO_LINKED_ACCOUNT',
          message: 'No FleetHQ account is linked to this email. Sign in with your username and password, or contact your fleet administrator.',
        });
      }
      if (candidates.length > 1) {
        // Email isn't unique in this schema (see findUserByIdentifier's doc
        // comment) — vanishingly rare, but auto-linking to the wrong one of
        // several accounts sharing an address would be a real account-
        // takeover risk, so this is refused rather than guessed at.
        throw new UnauthorizedException({ code: 'AMBIGUOUS_ACCOUNT', message: 'More than one account matches this email. Contact support.' });
      }
      user = candidates[0];
      await this.systemPrisma.oAuthIdentity.create({ data: { userId: user.id, provider, providerSubject: identity.subject, email: identity.email } });
    }

    if (!user || user.archivedAt) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid or expired sign-in.' });
    }

    const loginMethod: LoginMethod = provider === 'GOOGLE' ? 'oauth_google' : 'oauth_microsoft';
    return this.proceedPastFirstFactor(user, deviceFingerprint, rememberMe, loginMethod, context);
  }

  /**
   * Completes a login already fully authenticated by a verified WebAuthn/
   * passkey assertion (WebauthnService.verifyAuthentication). Deliberately
   * bypasses this account's own MFA policy — a passkey combines possession
   * of the authenticator with the platform's own biometric/PIN presence
   * check, which is itself multi-factor-equivalent, so re-challenging with
   * TOTP on top would add friction without adding real assurance. Unlike
   * password/magic-link/OAuth, it also isn't gated by device-trust (a
   * passkey ceremony is inherently device-bound already).
   */
  async completeWebauthnLogin(userId: string, context: AuthContext = {}): Promise<LoginResult> {
    const user = await this.systemPrisma.user.findUnique({ where: { id: userId } });
    if (!user || user.archivedAt) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid or expired sign-in.' });
    }
    return this.completeLogin(user, context, { loginMethod: 'webauthn' });
  }

  /**
   * Shared tail for every first-factor method (password, magic link, linked
   * social account): decide whether this account's MFA policy + device trust
   * require a second factor, or whether the login is already complete.
   */
  private async proceedPastFirstFactor(
    user: { id: string; username: string; tokenVersion: number; email: string | null; fullName: string; mfaEnabledAt: Date | null },
    deviceFingerprint: string | undefined,
    rememberMe: boolean,
    loginMethod: LoginMethod,
    context: AuthContext,
  ): Promise<LoginResult> {
    // A device this user has previously verified and asked to be remembered
    // skips the MFA challenge. Any other device — regardless of whether MFA
    // is even enabled on the account — is flagged for the new-device-login
    // alert email; this is a known, accepted simplification (it fires on
    // every login for an account that never opts into remembering a device),
    // not a precise "have we truly never seen this device" signal.
    const deviceTrusted = deviceFingerprint ? await this.sessions.isDeviceTrusted(user.id, deviceFingerprint) : false;
    const isNewDeviceLogin = !!deviceFingerprint && !deviceTrusted;

    // Second factor. If MFA is active and the device isn't trusted, no session
    // or company-choice token is issued until a valid code is presented to
    // POST /v1/auth/mfa/verify.
    if (user.mfaEnabledAt && !deviceTrusted) {
      const mfaPayload: MfaChallengePayload = { sub: user.id, mfa: true, deviceFingerprint, rememberMe, isNewDeviceLogin, loginMethod };
      return { status: 'mfa_required', mfaToken: this.jwt.sign(mfaPayload, { expiresIn: MFA_CHALLENGE_EXPIRES_IN }) };
    }

    return this.completeLogin(user, context, { rememberMe, isNewDeviceLogin, loginMethod });
  }

  /**
   * Verify the MFA second factor and, on success, complete the login exactly as
   * a password-only login would (single company → session; multiple → company
   * chooser). The challenge token is single-purpose and short-lived.
   */
  async verifyMfaChallenge(mfaToken: string, code: string, rememberDevice: boolean, context: AuthContext = {}): Promise<LoginResult> {
    let payload: MfaChallengePayload;
    try {
      payload = this.jwt.verify<MfaChallengePayload>(mfaToken);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    if (!payload.mfa) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    const user = await this.systemPrisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.archivedAt || !user.mfaEnabledAt) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    const result = await this.mfa.verifyChallenge(user, code);
    if (!result.ok) {
      void this.audit.recordSystem({
        action: AUDIT_ACTIONS.MFA_CHALLENGE_FAILED,
        outcome: 'failure',
        actorUserId: user.id,
        actorLabel: user.username,
        ip: context.ip,
        requestId: context.requestId,
      });
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }

    if (rememberDevice && payload.deviceFingerprint) {
      await this.sessions.trustDevice(user.id, payload.deviceFingerprint);
      void this.audit.recordSystem({
        action: AUDIT_ACTIONS.DEVICE_TRUSTED,
        actorUserId: user.id,
        actorLabel: user.username,
        ip: context.ip,
        requestId: context.requestId,
      });
    }

    return this.completeLogin(user, context, {
      usedBackupCode: result.usedBackupCode,
      rememberMe: payload.rememberMe,
      isNewDeviceLogin: payload.isNewDeviceLogin,
      loginMethod: payload.loginMethod,
    });
  }

  /** Resolve company access after all authentication factors have passed. */
  private async completeLogin(
    user: { id: string; username: string; tokenVersion: number; email: string | null; fullName: string },
    context: AuthContext,
    extra: { usedBackupCode?: boolean; rememberMe?: boolean; isNewDeviceLogin?: boolean; loginMethod?: LoginMethod } = {},
  ): Promise<LoginResult> {
    const memberships = await this.prisma.withUser(user.id, (tx) =>
      tx.companyMembership.findMany({
        // A suspended company (FleetHQ admin action, 21-Admin-Platform/Overview.md)
        // blocks login exactly like an archived one — suspension is meant to
        // actually stop access, not just flip a DB column.
        where: { userId: user.id, archivedAt: null, company: { archivedAt: null, suspendedAt: null } },
        include: { company: true },
      }),
    );

    if (memberships.length === 0) {
      this.logger.warn(
        { event: 'auth.login_denied', username: user.username, reason: 'no_company_access' },
        'Login denied: no active company access',
      );
      throw new UnauthorizedException({
        code: 'NO_COMPANY_ACCESS',
        message: 'This account has no active company access.',
      });
    }

    if (extra.isNewDeviceLogin && user.email) {
      void this.mail.sendNewDeviceLogin(user.email, user.fullName, context).catch(() => undefined);
    }

    if (memberships.length === 1) {
      const membership = memberships[0];
      this.logger.info(
        { event: 'auth.login_succeeded', username: user.username, userId: user.id, companyId: membership.companyId },
        'Login succeeded',
      );
      const accessToken = await this.issueSessionToken(user.id, membership.companyId, membership.id, user.tokenVersion, {
        ip: context.ip,
        userAgent: context.userAgent,
        rememberMe: extra.rememberMe,
      });
      void this.audit.recordSystem({
        companyId: membership.companyId,
        action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
        actorUserId: user.id,
        actorLabel: user.username,
        ip: context.ip,
        requestId: context.requestId,
        metadata: this.loginAuditMetadata(extra),
      });
      return {
        status: 'authenticated',
        accessToken,
        company: { id: membership.company.id, name: membership.company.name },
      };
    }

    const preAuthPayload: PreAuthJwtPayload = {
      sub: user.id,
      preAuth: true,
      rememberMe: extra.rememberMe,
      isNewDeviceLogin: extra.isNewDeviceLogin,
      loginMethod: extra.loginMethod,
    };
    return {
      status: 'choose_company',
      preAuthToken: this.jwt.sign(preAuthPayload, { expiresIn: PRE_AUTH_EXPIRES_IN }),
      companies: memberships.map((m) => ({ id: m.company.id, name: m.company.name })),
    };
  }

  /** `undefined` (not `{}`) when there's nothing to record, matching every other audit call's convention here. */
  private loginAuditMetadata(extra: { usedBackupCode?: boolean; loginMethod?: LoginMethod }): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {};
    if (extra.usedBackupCode) metadata.mfa = 'backup_code';
    if (extra.loginMethod && extra.loginMethod !== 'password') metadata.method = extra.loginMethod;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  async selectCompany(preAuthToken: string, companyId: string, context: AuthContext = {}): Promise<LoginResult> {
    let payload: PreAuthJwtPayload;
    try {
      payload = this.jwt.verify<PreAuthJwtPayload>(preAuthToken);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    if (!payload.preAuth) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }

    const membership = await this.prisma.withUser(payload.sub, (tx) =>
      tx.companyMembership.findFirst({
        where: {
          userId: payload.sub,
          companyId,
          archivedAt: null,
          company: { archivedAt: null, suspendedAt: null },
        },
        include: { company: true, user: { select: { tokenVersion: true, username: true, email: true, fullName: true } } },
      }),
    );

    if (!membership) {
      this.logger.warn(
        { event: 'auth.login_denied', userId: payload.sub, companyId, reason: 'no_company_access' },
        'Company selection denied: no active membership',
      );
      throw new UnauthorizedException({
        code: 'NO_COMPANY_ACCESS',
        message: 'No active membership for that company.',
      });
    }

    this.logger.info(
      { event: 'auth.login_succeeded', userId: payload.sub, companyId: membership.companyId },
      'Login succeeded (company selected)',
    );
    const accessToken = await this.issueSessionToken(payload.sub, membership.companyId, membership.id, membership.user.tokenVersion, {
      ip: context.ip,
      userAgent: context.userAgent,
      rememberMe: payload.rememberMe,
    });
    void this.audit.recordSystem({
      companyId: membership.companyId,
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorUserId: payload.sub,
      actorLabel: membership.user.username,
      ip: context.ip,
      requestId: context.requestId,
      metadata: this.loginAuditMetadata({ loginMethod: payload.loginMethod }),
    });

    if (payload.isNewDeviceLogin && membership.user.email) {
      void this.mail.sendNewDeviceLogin(membership.user.email, membership.user.fullName, context).catch(() => undefined);
    }

    return {
      status: 'authenticated',
      accessToken,
      company: { id: membership.company.id, name: membership.company.name },
    };
  }

  /**
   * Public so CompaniesService can mint an immediate session token right
   * after signup provisions a brand-new company — "10 minutes to first
   * value" (00-Company/Mission.md) means signup shouldn't require a separate
   * login round-trip straight after creating the account. Also used by the
   * FleetHQ admin platform's impersonation feature (21-Admin-Platform/Overview.md),
   * which passes a short `expiresIn` override — an impersonation session
   * should never carry the same 12h lifetime as a real login.
   *
   * Always creates a real UserSession row and embeds its id as the JWT's
   * `sid` claim — JwtStrategy checks that row on every request (see its doc
   * comment), so any token minted without one would be rejected on first use.
   */
  async issueSessionToken(
    userId: string,
    companyId: string,
    membershipId: string,
    tokenVersion: number,
    opts: { ip?: string | null; userAgent?: string | null; rememberMe?: boolean; expiresIn?: string } = {},
  ): Promise<string> {
    const sessionLifetimeMs = opts.rememberMe ? REMEMBER_ME_SESSION_EXPIRES_IN_MS : SESSION_EXPIRES_IN_MS;
    const session = await this.systemPrisma.userSession.create({
      data: {
        userId,
        companyId,
        membershipId,
        ipAddress: opts.ip ?? 'unknown',
        userAgent: opts.userAgent ?? null,
        expiresAt: new Date(Date.now() + sessionLifetimeMs),
      },
    });
    const payload: JwtPayload = { sub: userId, companyId, membershipId, tv: tokenVersion, sid: session.id };
    const expiresIn = opts.expiresIn ?? (opts.rememberMe ? REMEMBER_ME_EXPIRES_IN : undefined);
    return expiresIn ? this.jwt.sign(payload, { expiresIn }) : this.jwt.sign(payload);
  }

  /**
   * "Who am I, and what am I allowed to do" — added for FleetHQ, which needs
   * to proactively hide/disable nav items and actions based on the caller's
   * actual granted permissions (14-Security/Permissions_Model.md: "no feature
   * is gated by a hardcoded role check"), not just react to a 403 after the
   * fact. This is a read of the same Role -> RolePermission -> Permission
   * chain PermissionGuard already checks per-request, just returned in full
   * instead of checked against one key — no permissions are cached or baked
   * into anything long-lived, so a mid-session permission change is reflected
   * the next time the client calls this (matching PermissionGuard's own
   * "resolved fresh every time" discipline).
   */
  async getMe(companyId: string, membershipId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const membership = await tx.companyMembership.findUnique({
        where: { id: membershipId },
        include: {
          user: true,
          company: true,
          role: { include: { permissions: { include: { permission: true } } } },
        },
      });

      if (!membership) {
        // A valid, unexpired JWT pointing at a membership that's since been
        // deactivated/archived — treat it the same as any other auth failure.
        throw new UnauthorizedException({
          code: 'NO_COMPANY_ACCESS',
          message: 'This session is no longer valid for that company.',
        });
      }

      // DriverOS v0 (04-DriverOS/DriverOS_Overview.md): a User may also be
      // the login for an Operator record. Included here rather than as a
      // separate endpoint since it's the same "who am I" question DriverOS
      // asks right after login — null for the overwhelming majority of
      // FleetHQ-only users, who have no linked Operator at all.
      const operator = await tx.operator.findUnique({
        where: { userId: membership.userId },
        select: { id: true, fullName: true },
      });

      return {
        userId: membership.userId,
        username: membership.user.username,
        fullName: membership.user.fullName,
        email: membership.user.email,
        emailVerified: !!membership.user.emailVerifiedAt,
        mfaEnabled: !!membership.user.mfaEnabledAt,
        company: {
          id: membership.company.id,
          name: membership.company.name,
          jurisdiction: membership.company.jurisdiction,
        },
        membershipId: membership.id,
        role: { id: membership.role.id, name: membership.role.name },
        permissions: membership.role.permissions.map((rp) => rp.permission.key).sort(),
        operator,
      };
    });
  }

  // ── WebAuthn / passkeys (Auth/Billing Platform Phase 2) ─────────────────────

  async beginWebauthnRegistration(userId: string) {
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.webauthn.generateRegistrationOptionsFor(user.id, user.username, user.fullName);
  }

  async completeWebauthnRegistration(userId: string, challengeToken: string, response: RegistrationResponseJSON, deviceLabel?: string): Promise<void> {
    await this.webauthn.verifyRegistration(userId, challengeToken, response, deviceLabel);
  }

  async beginWebauthnLogin() {
    return this.webauthn.generateAuthenticationOptionsForLogin();
  }

  /** Usernameless passkey login: verify the assertion, then complete the login it authenticated. */
  async loginWithWebauthn(challengeToken: string, response: AuthenticationResponseJSON, context: AuthContext = {}): Promise<LoginResult> {
    const userId = await this.webauthn.verifyAuthentication(challengeToken, response);
    if (!userId) {
      throw new UnauthorizedException({ code: 'WEBAUTHN_VERIFICATION_FAILED', message: 'Could not verify that passkey.' });
    }
    return this.completeWebauthnLogin(userId, context);
  }

  listWebauthnCredentials(userId: string) {
    return this.webauthn.listCredentials(userId);
  }

  removeWebauthnCredential(userId: string, credentialId: string): Promise<void> {
    return this.webauthn.removeCredential(userId, credentialId);
  }

  // ── A2 auth completeness: lockout ────────────────────────────────────────────
  // (Email verification / password reset / resend live on AuthRecoveryService.)

  // Lock the account for LOCK_WINDOW after this many consecutive failures.
  private static readonly MAX_FAILED_LOGINS = 5;
  private static readonly LOCK_WINDOW_MS = 15 * 60 * 1000;

  private async recordFailedLogin(userId: string, currentCount: number): Promise<boolean> {
    const next = currentCount + 1;
    const locked = next >= AuthService.MAX_FAILED_LOGINS;
    await this.systemPrisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: locked ? 0 : next,
        lockedUntil: locked ? new Date(Date.now() + AuthService.LOCK_WINDOW_MS) : undefined,
      },
    });
    return locked;
  }
}
