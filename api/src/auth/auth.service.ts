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
import { PasswordPolicyService } from './password-policy.service';
import { AuthPolicyGateService } from './auth-policy-gate.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { MfaService } from './mfa/mfa.service';
import { OidcVerifierService } from './oidc-verifier.service';
import { WebauthnService } from './webauthn/webauthn.service';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { LoginMethod, MfaChallengePayload, PolicyActionPayload, PreAuthJwtPayload } from './jwt-payload.interface';
import { ADMIN_TIER_PERMISSION_KEYS, PermissionKey } from '../common/permissions/permission-catalog';

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

/** Step-up re-auth proof for a sensitive self-service action (e.g. adding a passkey). */
export interface StepUpReauth {
  currentPassword?: string;
  mfaCode?: string;
}

export type LoginResult =
  | { status: 'authenticated'; accessToken: string; company: CompanyChoice }
  | { status: 'choose_company'; preAuthToken: string; companies: CompanyChoice[] }
  | { status: 'mfa_required'; mfaToken: string }
  /** This company mandates MFA (Auth/Billing Platform Phase 3) and the account doesn't have it enabled yet. */
  | { status: 'mfa_setup_required'; setupToken: string }
  /** This company enforces a password-expiry window and the account's password has aged past it. */
  | { status: 'password_expired'; changeToken: string };

interface LoginUser {
  id: string;
  username: string;
  tokenVersion: number;
  email: string | null;
  fullName: string;
  mfaEnabledAt: Date | null;
  passwordChangedAt: Date;
}

interface LoginExtra {
  usedBackupCode?: boolean;
  rememberMe?: boolean;
  isNewDeviceLogin?: boolean;
  loginMethod?: LoginMethod;
}

/** What finishLoginForMembership needs to know about the destination company. */
interface MembershipWithSecurity {
  id: string;
  companyId: string;
  company: { id: string; name: string; securitySettings: { mfaRequired: boolean; passwordExpiryDays: number | null } | null };
}

const PRE_AUTH_EXPIRES_IN = '5m';
const MFA_CHALLENGE_EXPIRES_IN = '5m';
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
    private readonly passwordPolicy: PasswordPolicyService,
    private readonly policyGate: AuthPolicyGateService,
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
      if (locked) await this.handleAccountLocked(user, context);
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
      // First-time auto-link (this identity was NOT previously linked): a new
      // sign-in method has just been attached to the account purely on a
      // verified-email match, which — like a new passkey — the owner must be
      // told about. Audited and emailed on the same transparency principle as
      // every other security-footprint change (sendMfaEnabled / passkey add).
      if (!user.archivedAt) {
        this.notifyOAuthIdentityLinked(user, provider, context);
      }
    }

    if (!user || user.archivedAt) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid or expired sign-in.' });
    }

    const loginMethod: LoginMethod = provider === 'GOOGLE' ? 'oauth_google' : 'oauth_microsoft';
    return this.proceedPastFirstFactor(user, deviceFingerprint, rememberMe, loginMethod, context);
  }

  /**
   * Alert + audit when a verified external identity is auto-linked to an
   * existing account for the first time. Best-effort (never blocks the login),
   * mirroring how sendNewDeviceLogin / sendMfaEnabled are fired and how the
   * audit trail records other credential-footprint changes.
   */
  private notifyOAuthIdentityLinked(user: User, provider: OAuthProvider, context: AuthContext): void {
    const providerName = provider === OAuthProvider.GOOGLE ? 'Google' : 'Microsoft';
    const linkedAt = new Date();
    void this.audit.recordSystem({
      action: AUDIT_ACTIONS.OAUTH_IDENTITY_LINKED,
      actorUserId: user.id,
      actorLabel: user.username,
      targetType: 'user',
      targetId: user.id,
      ip: context.ip,
      requestId: context.requestId,
      metadata: { provider: providerName },
    });
    if (user.email) void this.mail.sendOAuthLinked(user.email, user.fullName, providerName, linkedAt).catch(() => undefined);
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
    user: LoginUser,
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
    // Auth/Billing Platform Phase 10: a client-supplied deviceFingerprint is
    // the strong signal above, but it's `@IsOptional()` on LoginDto — any
    // client that simply doesn't send one (or an attacker who omits it on
    // purpose) previously skipped the new-device alert entirely, silently.
    // When there's no fingerprint to check, fall back to "have we seen this
    // IP + user-agent for this user before" from actual session history —
    // deliberately independent of deviceTrusted/MFA-skip, this only decides
    // whether the alert email is worth sending.
    const isNewDeviceLogin = deviceFingerprint
      ? !deviceTrusted
      : !(await this.sessions.hasKnownIpUserAgent(user.id, context.ip, context.userAgent));

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
      // Pin the algorithm on verify (defence in depth — the module signs HS256):
      // never accept whatever `alg` the token header claims.
      payload = this.jwt.verify<MfaChallengePayload>(mfaToken, { algorithms: ['HS256'] });
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

    // Bound second-factor guessing at the account level. The per-IP throttle
    // alone can be sidestepped by rotating source IPs while replaying the same
    // still-valid 5-minute mfaToken, so reuse the same lockout counter the
    // password step uses: a locked account is refused outright.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }

    const result = await this.mfa.verifyChallenge(user, code);
    if (!result.ok) {
      const locked = await this.recordFailedLogin(user.id, user.failedLoginCount);
      if (locked) await this.handleAccountLocked(user, context);
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

    // A correct second factor clears any accumulated failures / lock.
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.systemPrisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
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
  private async completeLogin(user: LoginUser, context: AuthContext, extra: LoginExtra = {}): Promise<LoginResult> {
    const memberships = await this.prisma.withUser(user.id, (tx) =>
      tx.companyMembership.findMany({
        // A suspended company (FleetHQ admin action, 21-Admin-Platform/Overview.md)
        // blocks login exactly like an archived one — suspension is meant to
        // actually stop access, not just flip a DB column.
        where: { userId: user.id, archivedAt: null, company: { archivedAt: null, suspendedAt: null } },
        include: { company: { include: { securitySettings: true } } },
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

    if (memberships.length === 1) {
      return this.finishLoginForMembership(user, memberships[0], context, extra);
    }

    // Multi-company: the destination company isn't known yet, so no per-
    // company policy (mandatory MFA, password expiry) can be checked here —
    // it's checked once selectCompany() resolves which one was picked.
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
      // Pin the algorithm on verify (defence in depth — the module signs HS256):
      // never accept whatever `alg` the token header claims.
      payload = this.jwt.verify<PreAuthJwtPayload>(preAuthToken, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    if (!payload.preAuth) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }

    const membership = await this.resolveActiveMembership(payload.sub, companyId);
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
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: payload.sub } });

    return this.finishLoginForMembership(user, membership, context, {
      rememberMe: payload.rememberMe,
      isNewDeviceLogin: payload.isNewDeviceLogin,
      loginMethod: payload.loginMethod,
    });
  }

  /**
   * Shared tail for every path that reaches a resolved, single company
   * membership (a single-company login, a multi-company user's
   * select-company step, or resuming after a policy-gate action closes) —
   * checks that company's own security policy (Auth/Billing Platform Phase
   * 3) before finally issuing a session, and is the one place the
   * new-device-login alert email fires (previously duplicated between
   * completeLogin and selectCompany for the multi-company case).
   */
  /**
   * Whether admin-tier accounts must have MFA to complete login
   * (production-readiness audit: "enforce MFA for admin roles"). Defaults on in
   * every real environment; set `ENFORCE_ADMIN_MFA=false` to stage a rollout.
   * Defaults *off* under NODE_ENV=test so the broad e2e suite's password-only
   * admin logins aren't all forced through the MFA-setup wall — the dedicated
   * test for this behaviour opts in via the same env var.
   */
  private adminMfaEnforced(): boolean {
    const raw = process.env.ENFORCE_ADMIN_MFA;
    if (process.env.NODE_ENV === 'test') return raw === 'true';
    return raw !== 'false';
  }

  private async finishLoginForMembership(user: LoginUser, membership: MembershipWithSecurity, context: AuthContext, extra: LoginExtra): Promise<LoginResult> {
    // Only pay for the role-permission read when enforcement is actually on.
    const holdsAdminPermission = this.adminMfaEnforced()
      ? await this.membershipHoldsAdminPermission(membership.companyId, membership.id)
      : false;
    const blocked = this.policyGate.checkPolicy(user, membership, { ...extra, holdsAdminPermission });
    if (blocked) return blocked;

    if (extra.isNewDeviceLogin && user.email) {
      void this.mail.sendNewDeviceLogin(user.email, user.fullName, context).catch(() => undefined);
    }

    this.logger.info(
      { event: 'auth.login_succeeded', username: user.username, userId: user.id, companyId: membership.companyId },
      'Login succeeded',
    );
    const accessToken = await this.sessions.issueSessionToken(user.id, membership.companyId, membership.id, user.tokenVersion, {
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
    return { status: 'authenticated', accessToken, company: { id: membership.company.id, name: membership.company.name } };
  }

  /**
   * A user's active membership in one specific (active, non-suspended)
   * company, with what finishLoginForMembership needs. Deliberately doesn't
   * join `user` here even though it lives on the same row family — this
   * query runs inside `prisma.withUser` (only `app.current_user_id` set),
   * and the `users` table's RLS policy has no "visible to self" branch, only
   * a `current_company_id` one, so any join through it comes back null and
   * trips Prisma's own required-relation consistency check. Callers fetch
   * `User` separately via `systemPrisma`, the same pattern already used
   * everywhere else in this file.
   */
  private async resolveActiveMembership(userId: string, companyId: string): Promise<MembershipWithSecurity | null> {
    return this.prisma.withUser(userId, (tx) =>
      tx.companyMembership.findFirst({
        where: { userId, companyId, archivedAt: null, company: { archivedAt: null, suspendedAt: null } },
        include: { company: { include: { securitySettings: true } } },
      }),
    );
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
  /**
   * Whether this membership's role grants any admin-tier permission (see
   * ADMIN_TIER_PERMISSION_KEYS) — the signal that forces MFA at login even
   * when the company hasn't opted into a mandatory-MFA policy. Read under
   * `withTenant`: the `roles`/`role_permissions` RLS policies only expose rows
   * via `current_company_id`, not the `current_user_id` context login runs
   * under, so it can't be folded into the withUser membership query. The
   * companyId was already proven to belong to this user by the membership
   * query that produced it, so scoping a read to it here is safe.
   */
  private async membershipHoldsAdminPermission(companyId: string, membershipId: string): Promise<boolean> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const membership = await tx.companyMembership.findUnique({
        where: { id: membershipId },
        select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
      });
      return !!membership?.role.permissions.some((p) => ADMIN_TIER_PERMISSION_KEYS.has(p.permission.key as PermissionKey));
    });
  }

  async getMe(companyId: string, membershipId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const membership = await tx.companyMembership.findUnique({
        where: { id: membershipId },
        include: {
          user: true,
          company: { include: { securitySettings: true } },
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
        // Auth/Billing Platform Phase 3: lets the Profile page disable "turn
        // MFA off" and explain why, instead of only discovering the policy
        // the next time this account tries to log in without it.
        mfaRequiredByCompany: !!membership.company.securitySettings?.mfaRequired,
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

  // ── Policy-gate actions (Auth/Billing Platform Phase 3) ─────────────────────
  // A login blocked by finishLoginForMembership (mfa_setup_required /
  // password_expired) hands the frontend a short-lived token instead of a
  // session; these three endpoints close that gap and then resume issuing
  // the session exactly where the blocked login left off.

  /** Step 1 of forced MFA enrolment: issue the secret + otpauth URI, same as the normal self-service flow. */
  async beginPolicyMfaSetup(setupToken: string) {
    const payload = this.policyGate.verifyPolicyToken(setupToken, 'mfa_setup');
    return this.mfa.beginEnrollment(payload.sub);
  }

  /** Step 2: confirm the code (activating MFA), then finish the login it was blocking. */
  async confirmPolicyMfaSetup(setupToken: string, code: string, context: AuthContext = {}): Promise<LoginResult & { backupCodes: string[] }> {
    const payload = this.policyGate.verifyPolicyToken(setupToken, 'mfa_setup');
    const { backupCodes } = await this.mfa.confirmEnrollment(payload.sub, code);
    const result = await this.resumeLoginAfterPolicyAction(payload, context);
    return { ...result, backupCodes };
  }

  /**
   * Set a new password when a login was redirected here by this company's
   * password-expiry policy, then finish the login. Reuses the same history/
   * reuse-prevention and "kill every other session" treatment as a
   * self-service reset, since the account's password is genuinely changing.
   */
  async changeExpiredPassword(changeToken: string, newPassword: string, context: AuthContext = {}): Promise<LoginResult> {
    const payload = this.policyGate.verifyPolicyToken(changeToken, 'password_expired');
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
    await this.passwordPolicy.assertNotReused(user.id, newPassword, user.passwordHash);
    await this.passwordPolicy.recordPreviousHash(user.id, user.passwordHash);
    await this.systemPrisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
    });
    await this.sessions.revokeAllSessions(user.id);
    void this.audit.recordSystem({ action: AUDIT_ACTIONS.PASSWORD_CHANGED, actorUserId: user.id, actorLabel: user.username, ip: context.ip, requestId: context.requestId });
    if (user.email) void this.mail.sendPasswordChanged(user.email, user.fullName).catch(() => undefined);
    return this.resumeLoginAfterPolicyAction(payload, context);
  }

  /** Re-resolve the membership a policy-action token was minted for and finish issuing its session. */
  private async resumeLoginAfterPolicyAction(payload: PolicyActionPayload, context: AuthContext): Promise<LoginResult> {
    const membership = await this.resolveActiveMembership(payload.sub, payload.companyId);
    if (!membership || membership.id !== payload.membershipId) {
      throw new UnauthorizedException({ code: 'NO_COMPANY_ACCESS', message: 'No active membership for that company.' });
    }
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: payload.sub } });
    return this.finishLoginForMembership(user, membership, context, {
      rememberMe: payload.rememberMe,
      isNewDeviceLogin: payload.isNewDeviceLogin,
      loginMethod: payload.loginMethod,
    });
  }

  // ── WebAuthn / passkeys (Auth/Billing Platform Phase 2) ─────────────────────

  async beginWebauthnRegistration(userId: string) {
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    return this.webauthn.generateRegistrationOptionsFor(user.id, user.username, user.fullName);
  }

  /**
   * Enrol a new passkey. Adding a passkey creates a durable, standalone way
   * back into the account, so it gets the exact same discipline as a
   * self-service password change or an MFA enable/disable:
   *  - step-up re-authentication (current password OR a live MFA code), so a
   *    merely-valid — possibly 12h/30-day-old — access token isn't enough on
   *    its own (mirrors AuthRecoveryService.changePassword / MfaService.disable);
   *  - every *other* session revoked, same as changePassword/MFA-change, since
   *    enrolling a new credential is exactly when a stale session an attacker
   *    may hold should be forced back through login;
   *  - a notification email to the account owner (mirrors sendMfaEnabled);
   *  - an audit-log entry (written inside WebauthnService.verifyRegistration,
   *    mirroring MfaService.confirmEnrollment's MFA_ENABLED record).
   */
  async completeWebauthnRegistration(
    userId: string,
    currentSessionId: string,
    challengeToken: string,
    response: RegistrationResponseJSON,
    reauth: StepUpReauth,
    deviceLabel?: string,
    context: AuthContext = {},
  ): Promise<void> {
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.assertStepUpReauth(user, reauth);
    await this.webauthn.verifyRegistration(userId, challengeToken, response, deviceLabel, {
      actorLabel: user.username,
      ip: context.ip,
      requestId: context.requestId,
    });
    // Same "kill every other session on a credential change" treatment as a
    // self-service password change / MFA enable; the current device stays.
    await this.sessions.revokeOtherSessions(userId, currentSessionId);
    if (user.email) void this.mail.sendPasskeyAdded(user.email, user.fullName, deviceLabel ?? null).catch(() => undefined);
  }

  /**
   * Re-prove a live credential before a sensitive self-service action. Accepts
   * the current password (as AuthRecoveryService.changePassword does) OR a
   * current MFA code (TOTP/backup, as MfaService.disable does) for accounts
   * with MFA enabled. Neither valid ⇒ rejected — a bare access token is never
   * sufficient on its own.
   */
  private async assertStepUpReauth(user: User, reauth: StepUpReauth): Promise<void> {
    if (reauth.currentPassword) {
      if (await bcrypt.compare(reauth.currentPassword, user.passwordHash)) return;
      throw new UnauthorizedException({ code: 'REAUTH_REQUIRED', message: 'That current password is incorrect.' });
    }
    if (reauth.mfaCode && user.mfaEnabledAt) {
      const result = await this.mfa.verifyChallenge(user, reauth.mfaCode);
      if (result.ok) return;
      throw new UnauthorizedException({ code: 'REAUTH_REQUIRED', message: 'That verification code is incorrect.' });
    }
    throw new UnauthorizedException({
      code: 'REAUTH_REQUIRED',
      message: 'Re-enter your current password or a verification code to add a passkey.',
    });
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

  async removeWebauthnCredential(userId: string, credentialId: string, context: AuthContext = {}): Promise<void> {
    const user = await this.systemPrisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    await this.webauthn.removeCredential(userId, credentialId, {
      actorLabel: user?.username ?? null,
      ip: context.ip,
      requestId: context.requestId,
    });
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

  /** Records the audit event and (Auth/Billing Platform Phase 6) sends the account-locked security alert, once `recordFailedLogin` has actually flipped the account to locked. */
  private async handleAccountLocked(user: User, context: AuthContext): Promise<void> {
    // Structured event so a CloudWatch metric filter can alarm on a burst of
    // lockouts (credential-stuffing) — see infra/terraform/modules/monitoring.
    this.logger.warn({ event: 'auth.account_locked', username: user.username, userId: user.id }, 'Account locked after repeated failures');
    void this.audit.recordSystem({
      action: AUDIT_ACTIONS.LOGIN_LOCKED_OUT,
      outcome: 'failure',
      actorUserId: user.id,
      actorLabel: user.username,
      ip: context.ip,
      requestId: context.requestId,
    });
    if (user.email) {
      void this.mail.sendAccountLocked(user.email, user.fullName, new Date(Date.now() + AuthService.LOCK_WINDOW_MS)).catch(() => undefined);
    }
  }
}
