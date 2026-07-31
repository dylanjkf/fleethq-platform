import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
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

/**
 * Session listing/revocation and "remember this device" bookkeeping for
 * customer User accounts — split out of AuthService (Auth/Billing Platform
 * Phase 2) purely to keep that file under this repo's line-count lint rule;
 * this is bookkeeping around a session, not authentication itself. Session
 * *creation* (AuthService.issueSessionToken, which signs the JWT) stays on
 * AuthService, since CompaniesService/AdminOrganisationsService already
 * depend on it there.
 */
@Injectable()
export class AuthSessionsService {
  constructor(
    private readonly systemPrisma: SystemPrismaService,
    private readonly audit: AuditService,
  ) {}

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
