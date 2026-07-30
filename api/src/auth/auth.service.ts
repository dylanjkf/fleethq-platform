import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuthTokensService } from './auth-tokens.service';
import { AuthMailService } from './auth-mail.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { MfaService } from './mfa/mfa.service';
import { JwtPayload, MfaChallengePayload, PreAuthJwtPayload } from './jwt-payload.interface';

/** Optional request context threaded from the controller for audit records. */
export interface AuthContext {
  ip?: string | null;
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

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly jwt: JwtService,
    private readonly authTokens: AuthTokensService,
    private readonly mail: AuthMailService,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  async login(username: string, password: string, context: AuthContext = {}): Promise<LoginResult> {
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
      await bcrypt.compare(password, '$2b$10$invalidsaltinvalidsaltinvalidsaltuz');
      throw invalidCredentials(user ? 'account_archived' : 'unknown_username');
    }

    // Brute-force lock: a locked account is refused without even checking the
    // password (dummy compare keeps timing flat), and the lock clears on its
    // own once the window passes.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await bcrypt.compare(password, '$2b$10$invalidsaltinvalidsaltinvalidsaltuz');
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

    // Second factor. If MFA is active, no session or company-choice token is
    // issued until a valid code is presented to POST /v1/auth/mfa/verify.
    if (user.mfaEnabledAt) {
      const mfaPayload: MfaChallengePayload = { sub: user.id, mfa: true };
      return { status: 'mfa_required', mfaToken: this.jwt.sign(mfaPayload, { expiresIn: MFA_CHALLENGE_EXPIRES_IN }) };
    }

    return this.completeLogin(user, context);
  }

  /**
   * Verify the MFA second factor and, on success, complete the login exactly as
   * a password-only login would (single company → session; multiple → company
   * chooser). The challenge token is single-purpose and short-lived.
   */
  async verifyMfaChallenge(mfaToken: string, code: string, context: AuthContext = {}): Promise<LoginResult> {
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
    return this.completeLogin(user, context, { usedBackupCode: result.usedBackupCode });
  }

  /** Resolve company access after all authentication factors have passed. */
  private async completeLogin(
    user: { id: string; username: string; tokenVersion: number },
    context: AuthContext,
    extra: { usedBackupCode?: boolean } = {},
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

    if (memberships.length === 1) {
      const membership = memberships[0];
      this.logger.info(
        { event: 'auth.login_succeeded', username: user.username, userId: user.id, companyId: membership.companyId },
        'Login succeeded',
      );
      void this.audit.recordSystem({
        companyId: membership.companyId,
        action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
        actorUserId: user.id,
        actorLabel: user.username,
        ip: context.ip,
        requestId: context.requestId,
        metadata: extra.usedBackupCode ? { mfa: 'backup_code' } : undefined,
      });
      return {
        status: 'authenticated',
        accessToken: this.issueSessionToken(user.id, membership.companyId, membership.id, user.tokenVersion),
        company: { id: membership.company.id, name: membership.company.name },
      };
    }

    const preAuthPayload: PreAuthJwtPayload = { sub: user.id, preAuth: true };
    return {
      status: 'choose_company',
      preAuthToken: this.jwt.sign(preAuthPayload, { expiresIn: PRE_AUTH_EXPIRES_IN }),
      companies: memberships.map((m) => ({ id: m.company.id, name: m.company.name })),
    };
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
        include: { company: true, user: { select: { tokenVersion: true, username: true } } },
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
    void this.audit.recordSystem({
      companyId: membership.companyId,
      action: AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      actorUserId: payload.sub,
      actorLabel: membership.user.username,
      ip: context.ip,
      requestId: context.requestId,
    });
    return {
      status: 'authenticated',
      accessToken: this.issueSessionToken(payload.sub, membership.companyId, membership.id, membership.user.tokenVersion),
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
   */
  issueSessionToken(userId: string, companyId: string, membershipId: string, tokenVersion: number, expiresIn?: string): string {
    const payload: JwtPayload = { sub: userId, companyId, membershipId, tv: tokenVersion };
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

  // ── A2 auth completeness: lockout + verification + reset ────────────────────

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

  private async findUserByIdentifier(identifier: string) {
    // Username is unique; email is not (nullable, shared-family addresses), so
    // an email match takes the most recently active account for it.
    const byUsername = await this.systemPrisma.user.findUnique({ where: { username: identifier } });
    if (byUsername) return byUsername;
    return this.systemPrisma.user.findFirst({
      where: { email: identifier, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Always resolves to the same shape regardless of whether the account exists
   * or has an email — so this endpoint can't be used to probe who has an
   * account. The email is only sent when there's a real, non-archived account
   * with an address on file.
   */
  async forgotPassword(identifier: string): Promise<void> {
    const user = await this.findUserByIdentifier(identifier);
    if (!user || user.archivedAt || !user.email) return;
    const token = await this.authTokens.issue(user.id, 'PASSWORD_RESET');
    await this.mail.sendPasswordReset(user.email, user.fullName, token);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.authTokens.consume(token, 'PASSWORD_RESET');
    if (!userId) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This reset link is invalid or has expired.' });
    }
    await this.systemPrisma.user.update({
      where: { id: userId },
      // A completed reset also proves control of the mailbox, so mark the email
      // verified, and clear any lockout so the user can sign in immediately.
      // Bump tokenVersion so every session issued before the reset is revoked
      // at once (a reset is exactly when you want existing sessions killed).
      data: {
        passwordHash: await bcrypt.hash(newPassword, 10),
        emailVerifiedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
    });
    await this.authTokens.invalidateAll(userId, 'PASSWORD_RESET');
    void this.audit.recordSystem({ action: AUDIT_ACTIONS.PASSWORD_RESET, actorUserId: userId, targetType: 'user', targetId: userId });
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.authTokens.consume(token, 'EMAIL_VERIFY');
    if (!userId) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This verification link is invalid or has expired.' });
    }
    await this.systemPrisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  }

  async resendVerification(identifier: string): Promise<void> {
    const user = await this.findUserByIdentifier(identifier);
    if (!user || user.archivedAt || !user.email || user.emailVerifiedAt) return;
    const token = await this.authTokens.issue(user.id, 'EMAIL_VERIFY');
    await this.mail.sendVerification(user.email, user.fullName, token);
  }
}
