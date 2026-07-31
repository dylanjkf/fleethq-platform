import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import type { JwtPayload } from './jwt-payload.interface';
import type { AuthContext } from './auth.service';

export interface UserSessionSummary {
  id: string;
  ipAddress: string;
  userAgent: string | null;
  deviceLabel: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

const TRUSTED_DEVICE_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_EXPIRES_IN_MS = 12 * 60 * 60 * 1000; // 12h — matches JWT_EXPIRES_IN's default
const REMEMBER_ME_EXPIRES_IN = '30d';
const REMEMBER_ME_SESSION_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Session listing/revocation, "remember this device" bookkeeping, and session
 * *creation* (`issueSessionToken`, which signs the JWT) for customer User
 * accounts — split out of AuthService (Auth/Billing Platform Phase 2) purely
 * to keep that file under this repo's line-count lint rule. `issueSessionToken`
 * is also called directly by CompaniesService (signup) and
 * AdminOrganisationsService (impersonation), same as when it lived on
 * AuthService — moved here (Phase 3) so AuthService's own policy-gate helper
 * (`finishLoginForMembership`) can call it without AuthSessionsService having
 * to depend back on AuthService, which would be circular.
 */
@Injectable()
export class AuthSessionsService {
  constructor(
    private readonly systemPrisma: SystemPrismaService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
  ) {}

  /**
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

  async listSessions(userId: string, currentSessionId: string): Promise<UserSessionSummary[]> {
    const sessions = await this.systemPrisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
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

  /** Self-service session revocation — a user killing one of their own other devices. */
  async revokeSession(userId: string, sessionId: string, context: AuthContext = {}): Promise<void> {
    const session = await this.systemPrisma.userSession.findFirst({ where: { id: sessionId, userId } });
    if (!session || session.revokedAt) return;
    await this.systemPrisma.userSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    void this.audit.recordSystem({
      companyId: session.companyId,
      action: AUDIT_ACTIONS.SESSION_REVOKED,
      actorUserId: userId,
      targetType: 'user_session',
      targetId: sessionId,
      ip: context.ip,
      requestId: context.requestId,
    });
  }

  async logout(userId: string, companyId: string, sessionId: string, context: AuthContext = {}): Promise<void> {
    await this.systemPrisma.userSession.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    void this.audit.recordSystem({
      companyId,
      action: AUDIT_ACTIONS.LOGOUT,
      actorUserId: userId,
      targetType: 'user_session',
      targetId: sessionId,
      ip: context.ip,
      requestId: context.requestId,
    });
  }

  /** Revoke every active session for a user — used when a password reset should kill all existing sessions. */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.systemPrisma.userSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async isDeviceTrusted(userId: string, deviceFingerprint: string): Promise<boolean> {
    const device = await this.systemPrisma.userTrustedDevice.findUnique({
      where: { userId_deviceFingerprint: { userId, deviceFingerprint: this.hashFingerprint(deviceFingerprint) } },
    });
    return !!device && device.expiresAt > new Date();
  }

  async trustDevice(userId: string, deviceFingerprint: string): Promise<void> {
    const hashed = this.hashFingerprint(deviceFingerprint);
    await this.systemPrisma.userTrustedDevice.upsert({
      where: { userId_deviceFingerprint: { userId, deviceFingerprint: hashed } },
      create: { userId, deviceFingerprint: hashed, expiresAt: new Date(Date.now() + TRUSTED_DEVICE_EXPIRES_IN_MS) },
      update: { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + TRUSTED_DEVICE_EXPIRES_IN_MS) },
    });
  }

  /** Never store a client-supplied identifier verbatim, even though it isn't a credential. */
  private hashFingerprint(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /** Random device id the frontend generates and persists client-side (e.g. localStorage). */
  static generateDeviceFingerprint(): string {
    return randomUUID();
  }
}
