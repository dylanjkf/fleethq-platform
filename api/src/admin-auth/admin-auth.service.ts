import { createHash, randomUUID } from 'crypto';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as bcrypt from 'bcrypt';
import { resolveBcryptCost } from '../common/security/bcrypt-cost';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminMfaService } from './mfa/admin-mfa.service';
import { AdminAuthMailService } from './admin-auth-mail.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS, AdminAuditAction } from '../admin-audit/admin-audit.service';
import { AdminJwtPayload, AdminMfaChallengePayload } from './admin-jwt-payload.interface';
import { isStrongPassword } from '../common/validators/is-strong-password.validator';
import { staffAdminMfaEnforced } from './staff-admin-mfa-policy';

export interface AdminAuthContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AdminSessionSummary {
  id: string;
  ipAddress: string;
  userAgent: string | null;
  deviceLabel: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

export type AdminLoginResult =
  | { status: 'authenticated'; accessToken: string; admin: { id: string; username: string; fullName: string; mustResetPassword: boolean } }
  | { status: 'mfa_required'; mfaToken: string };

const MFA_CHALLENGE_EXPIRES_IN = '5m';
const SESSION_EXPIRES_IN_MS = 12 * 60 * 60 * 1000; // 12h, matching the customer session lifetime
const TRUSTED_DEVICE_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DUMMY_HASH = '$2b$10$invalidsaltinvalidsaltinvalidsaltuz';

@Injectable()
export class AdminAuthService {
  private static readonly MAX_FAILED_LOGINS = 5;
  private static readonly LOCK_WINDOW_MS = 15 * 60 * 1000;

  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly jwt: JwtService,
    private readonly mfa: AdminMfaService,
    private readonly audit: AdminAuditService,
    private readonly mail: AdminAuthMailService,
    @InjectPinoLogger(AdminAuthService.name) private readonly logger: PinoLogger,
  ) {}

  async login(username: string, password: string, deviceFingerprint: string | undefined, context: AdminAuthContext = {}): Promise<AdminLoginResult> {
    const user = await this.adminPrisma.adminUser.findUnique({ where: { username } });

    const invalidCredentials = async (reason: string) => {
      await this.recordAttempt(username, false, reason, context);
      this.logger.warn({ event: 'admin_auth.login_failed', username, reason }, 'Admin login failed');
      return new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' });
    };

    if (!user || user.archivedAt) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw await invalidCredentials(user ? 'account_disabled' : 'unknown_username');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await bcrypt.compare(password, DUMMY_HASH);
      throw await invalidCredentials('account_locked');
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      const locked = await this.recordFailedLogin(user.id);
      if (locked) {
        this.logger.warn({ event: 'admin_auth.account_locked', username, adminUserId: user.id }, 'Admin account locked after repeated failures');
        await this.audit.record({
          adminUserId: user.id,
          action: ADMIN_AUDIT_ACTIONS.LOGIN_LOCKED_OUT,
          entityType: 'admin_user',
          entityId: user.id,
          ip: context.ip,
          userAgent: context.userAgent,
        });
      }
      throw await invalidCredentials('wrong_password');
    }

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.adminPrisma.adminUser.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    }

    await this.recordAttempt(username, true, null, context);

    // MFA is skipped only for a device this admin has previously verified and
    // explicitly asked to be remembered — "remember trusted devices".
    const deviceTrusted = deviceFingerprint ? await this.isDeviceTrusted(user.id, deviceFingerprint) : false;

    if (user.mfaEnabledAt && !deviceTrusted) {
      const payload: AdminMfaChallengePayload = { sub: user.id, mfa: true, deviceFingerprint };
      return { status: 'mfa_required', mfaToken: this.jwt.sign(payload, { expiresIn: MFA_CHALLENGE_EXPIRES_IN }) };
    }

    return this.completeLogin(user.id, context);
  }

  async verifyMfaChallenge(
    mfaToken: string,
    code: string,
    rememberDevice: boolean,
    context: AdminAuthContext = {},
  ): Promise<AdminLoginResult> {
    let payload: AdminMfaChallengePayload;
    try {
      payload = this.jwt.verify<AdminMfaChallengePayload>(mfaToken);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    if (!payload.mfa) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }

    const user = await this.adminPrisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!user || user.archivedAt || !user.mfaEnabledAt) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }

    const result = await this.mfa.verifyChallenge(user, code);
    if (!result.ok) {
      await this.auditAdminUserEvent(user.id, ADMIN_AUDIT_ACTIONS.MFA_CHALLENGE_FAILED, context);
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }
    if (result.usedBackupCode) {
      await this.auditAdminUserEvent(user.id, ADMIN_AUDIT_ACTIONS.MFA_BACKUP_CODE_USED, context);
    }

    if (rememberDevice && payload.deviceFingerprint) {
      await this.trustDevice(user.id, payload.deviceFingerprint);
      await this.auditAdminUserEvent(user.id, ADMIN_AUDIT_ACTIONS.DEVICE_TRUSTED, context);
    }

    return this.completeLogin(user.id, context);
  }

  private async completeLogin(adminUserId: string, context: AdminAuthContext): Promise<AdminLoginResult> {
    const user = await this.adminPrisma.adminUser.findUniqueOrThrow({ where: { id: adminUserId } });

    // New-device / new-location sign-in alert (admin console equivalent of the
    // customer-side AuthService new-device email). Decide *before* creating the
    // session row, since creating it is exactly what records this ip+userAgent
    // as "seen" — so the same device next time won't re-alert.
    const isNewDeviceLogin = !(await this.hasKnownIpUserAgent(user.id, context.ip, context.userAgent));

    const session = await this.adminPrisma.adminSession.create({
      data: {
        adminUserId: user.id,
        ipAddress: context.ip ?? 'unknown',
        userAgent: context.userAgent ?? null,
        expiresAt: new Date(Date.now() + SESSION_EXPIRES_IN_MS),
      },
    });

    // Best-effort, fire-and-forget: an unseen device gets the owner an email
    // pointing at the session review/revoke page. Never block or roll back the
    // login on a slow/failed send (mirrors the customer call site).
    if (isNewDeviceLogin && user.email) {
      void this.mail
        .sendNewDeviceLogin(user.email, user.fullName, { ip: context.ip, userAgent: context.userAgent, when: session.createdAt })
        .catch(() => undefined);
    }

    const tokenPayload: AdminJwtPayload = { sub: user.id, sid: session.id, tv: user.tokenVersion };
    await this.audit.record({
      adminUserId: user.id,
      action: ADMIN_AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      entityType: 'admin_user',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return {
      status: 'authenticated',
      accessToken: this.jwt.sign(tokenPayload, { expiresIn: `${SESSION_EXPIRES_IN_MS}ms` }),
      admin: { id: user.id, username: user.username, fullName: user.fullName, mustResetPassword: user.mustResetPassword },
    };
  }

  /** "Who am I" — identity plus the granted permission keys the admin SPA gates its UI on. */
  async getMe(adminUserId: string) {
    const user = await this.adminPrisma.adminUser.findUniqueOrThrow({
      where: { id: adminUserId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    const mfaEnabled = !!user.mfaEnabledAt;
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      mfaEnabled,
      mustResetPassword: user.mustResetPassword,
      role: { id: user.role.id, name: user.role.name },
      permissions: user.role.permissions.map((p) => p.permission.key),
      // Pending account-setup obligations the SPA must force before the console
      // is usable — mirrors AdminPermissionGuard's server-side enforcement so the
      // UI and the API agree on what's blocked (Round 3 High #1/#3).
      obligations: {
        passwordReset: user.mustResetPassword,
        mfaEnrollment: staffAdminMfaEnforced() && !mfaEnabled,
      },
    };
  }

  /**
   * Change the calling admin's own password. Clears a forced-reset obligation,
   * stamps passwordChangedAt, and bumps tokenVersion to revoke every *other*
   * live session immediately (the caller gets a freshly-minted token back so
   * they stay signed in). Verifies the current password first and enforces the
   * same strength policy as the rest of the platform. Round 3 High #3.
   */
  async changePassword(
    adminUserId: string,
    sessionId: string,
    currentPassword: string,
    newPassword: string,
    context: AdminAuthContext = {},
  ): Promise<{ accessToken: string }> {
    const user = await this.adminPrisma.adminUser.findUniqueOrThrow({ where: { id: adminUserId } });

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Your current password is incorrect.' });
    }
    if (!isStrongPassword(newPassword)) {
      throw new BadRequestException({
        code: 'WEAK_PASSWORD',
        message: 'Password must be at least 8 characters and mix at least two of lowercase, uppercase, number, and symbol.',
      });
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException({ code: 'PASSWORD_REUSED', message: 'Choose a password different from your current one.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, resolveBcryptCost());
    const updated = await this.adminPrisma.adminUser.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        mustResetPassword: false,
        tokenVersion: { increment: 1 }, // revoke all existing sessions' tokens
      },
    });

    await this.audit.record({
      adminUserId: user.id,
      action: ADMIN_AUDIT_ACTIONS.ADMIN_USER_PASSWORD_CHANGED,
      entityType: 'admin_user',
      entityId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    // Re-mint the caller's own token against the bumped tokenVersion so this
    // session survives the mass-revoke it just triggered.
    const tokenPayload: AdminJwtPayload = { sub: user.id, sid: sessionId, tv: updated.tokenVersion };
    return { accessToken: this.jwt.sign(tokenPayload, { expiresIn: `${SESSION_EXPIRES_IN_MS}ms` }) };
  }

  async listSessions(adminUserId: string, currentSessionId: string): Promise<AdminSessionSummary[]> {
    const sessions = await this.adminPrisma.adminSession.findMany({
      where: { adminUserId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      deviceLabel: s.deviceLabel,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      isCurrent: s.id === currentSessionId,
    }));
  }

  /**
   * Revoke every live session for an admin at once — the mechanism a password
   * reset uses to kill all existing devices (mirrors
   * AuthSessionsService.revokeAllSessions on the customer side). tokenVersion
   * is bumped separately by the caller to invalidate the JWTs immediately; this
   * flips the session rows so listSessions stops showing devices that look
   * "active" and aren't.
   */
  async revokeAllSessions(adminUserId: string): Promise<void> {
    await this.adminPrisma.adminSession.updateMany({
      where: { adminUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Self-service session revocation — an admin killing one of their own other devices. */
  async revokeOwnSession(adminUserId: string, sessionId: string, context: AdminAuthContext): Promise<void> {
    const session = await this.adminPrisma.adminSession.findFirst({ where: { id: sessionId, adminUserId } });
    if (!session || session.revokedAt) return;
    await this.adminPrisma.adminSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await this.audit.record({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.SESSION_REVOKED,
      entityType: 'admin_session',
      entityId: sessionId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  async logout(adminUserId: string, sessionId: string, context: AdminAuthContext = {}): Promise<void> {
    await this.adminPrisma.adminSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.LOGOUT,
      entityType: 'admin_session',
      entityId: sessionId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * "Have we seen this admin on this IP + user-agent before" — the new-device
   * signal behind the sign-in alert email, mirroring
   * AuthSessionsService.hasKnownIpUserAgent on the customer side. Reads the
   * existing admin_sessions history (the same rows the session-review UI
   * lists); deliberately independent of the trusted-device fingerprint, which
   * only governs whether MFA is skipped, not whether the alert is worth
   * sending. An unknown/missing IP is treated as "not seen" so the alert still
   * fires rather than silently swallowing an odd-looking login.
   */
  async hasKnownIpUserAgent(adminUserId: string, ip: string | null | undefined, userAgent: string | null | undefined): Promise<boolean> {
    if (!ip || ip === 'unknown') return false;
    const existing = await this.adminPrisma.adminSession.findFirst({
      where: { adminUserId, ipAddress: ip, userAgent: userAgent ?? null },
      select: { id: true },
    });
    return !!existing;
  }

  private async isDeviceTrusted(adminUserId: string, deviceFingerprint: string): Promise<boolean> {
    const device = await this.adminPrisma.adminTrustedDevice.findUnique({
      where: { adminUserId_deviceFingerprint: { adminUserId, deviceFingerprint: this.hashFingerprint(deviceFingerprint) } },
    });
    return !!device && device.expiresAt > new Date();
  }

  private async trustDevice(adminUserId: string, deviceFingerprint: string): Promise<void> {
    const hashed = this.hashFingerprint(deviceFingerprint);
    await this.adminPrisma.adminTrustedDevice.upsert({
      where: { adminUserId_deviceFingerprint: { adminUserId, deviceFingerprint: hashed } },
      create: { adminUserId, deviceFingerprint: hashed, expiresAt: new Date(Date.now() + TRUSTED_DEVICE_EXPIRES_IN_MS) },
      update: { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + TRUSTED_DEVICE_EXPIRES_IN_MS) },
    });
  }

  /** Never store a client-supplied identifier verbatim, even though it isn't a credential. */
  private hashFingerprint(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private async auditAdminUserEvent(adminUserId: string, action: AdminAuditAction, context: AdminAuthContext): Promise<void> {
    await this.audit.record({
      adminUserId,
      action,
      entityType: 'admin_user',
      entityId: adminUserId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  private async recordAttempt(username: string, success: boolean, failureReason: string | null, context: AdminAuthContext): Promise<void> {
    await this.adminPrisma.adminLoginAttempt.create({
      data: {
        usernameTried: username,
        ipAddress: context.ip ?? 'unknown',
        userAgent: context.userAgent ?? null,
        success,
        failureReason,
      },
    });
    if (!success) {
      await this.audit.record({
        action: ADMIN_AUDIT_ACTIONS.LOGIN_FAILED,
        entityType: 'admin_login_attempt',
        entityId: null,
        ip: context.ip,
        userAgent: context.userAgent,
        reason: failureReason,
      });
    }
  }

  private async recordFailedLogin(adminUserId: string): Promise<boolean> {
    // Atomic increment so concurrent failed attempts can't lose updates and slip
    // past MAX_FAILED_LOGINS (mirrors AuthService.recordFailedLogin).
    const { failedLoginCount } = await this.adminPrisma.adminUser.update({
      where: { id: adminUserId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const locked = failedLoginCount >= AdminAuthService.MAX_FAILED_LOGINS;
    if (locked) {
      await this.adminPrisma.adminUser.update({
        where: { id: adminUserId },
        data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + AdminAuthService.LOCK_WINDOW_MS) },
      });
    }
    return locked;
  }

  /** Random device id the future admin SPA generates and persists client-side (e.g. localStorage). */
  static generateDeviceFingerprint(): string {
    return randomUUID();
  }
}
