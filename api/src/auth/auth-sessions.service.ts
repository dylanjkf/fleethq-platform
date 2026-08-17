import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';
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
/**
 * "Remember me" bearer-token lifetime (security audit, Low — reviewed and kept
 * deliberately). 30 days is long for a token sitting in localStorage, and the
 * tradeoff is accepted because revocation is real and server-side: every
 * request checks the session row (revokedAt / expiresAt) and the user's
 * tokenVersion, so a "remember me" token is killed the instant the session is
 * revoked, the password is changed, or all sessions are dropped — it is not a
 * fire-and-forget 30-day grant. Shorten this constant if the risk posture
 * changes; the accompanying DB session row's expiry is bounded by
 * REMEMBER_ME_SESSION_EXPIRES_IN_MS below to match.
 */
const REMEMBER_ME_EXPIRES_IN = '30d';
const REMEMBER_ME_SESSION_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Auth/Billing Platform Phase 10 (security hardening depth): a cap on how
 * many sessions one account can hold at once. Without this, a slowly-leaked
 * or repeatedly-phished credential accumulates unlimited concurrent
 * sessions — `listSessions` would just get longer, with nothing forcing the
 * oldest, most-likely-abandoned ones to ever go away. Generous enough not to
 * bother a real user signed in across several devices; bounded enough to cap
 * the blast radius of a leaked credential.
 */
const MAX_ACTIVE_SESSIONS_PER_USER = 10;

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
    opts: { ip?: string | null; userAgent?: string | null; rememberMe?: boolean; expiresIn?: string; deviceFingerprint?: string | null } = {},
  ): Promise<string> {
    await this.enforceSessionCap(userId);
    const sessionLifetimeMs = opts.rememberMe ? REMEMBER_ME_SESSION_EXPIRES_IN_MS : SESSION_EXPIRES_IN_MS;
    const session = await this.systemPrisma.userSession.create({
      data: {
        userId,
        companyId,
        membershipId,
        ipAddress: opts.ip ?? 'unknown',
        userAgent: opts.userAgent ?? null,
        // Hashed, never stored raw (see hashFingerprint) — lets a later login from
        // the same device be recognised as not-new (A3) without holding a
        // client-supplied identifier verbatim.
        deviceFingerprint: opts.deviceFingerprint ? this.hashFingerprint(opts.deviceFingerprint) : null,
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
      // Bounded to MAX_ACTIVE_SESSIONS_PER_USER by enforceSessionCap in practice;
      // MAX_AGGREGATION_ROWS is a defensive backstop so a session table anomaly
      // can't turn this list read into an unbounded load.
      take: MAX_AGGREGATION_ROWS,
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

  /**
   * Auth/Billing Platform Phase 10: revoke every *other* active session,
   * keeping `exceptSessionId` alive — used after a self-service password
   * change or MFA enable/disable, where the caller has just proved they're
   * the legitimate account holder on *this* device and shouldn't be logged
   * out of it, but any session an attacker may be holding elsewhere should
   * die immediately rather than survive until it happens to expire.
   */
  async revokeOtherSessions(userId: string, exceptSessionId: string): Promise<void> {
    await this.systemPrisma.userSession.updateMany({
      where: { userId, revokedAt: null, id: { not: exceptSessionId } },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Auth/Billing Platform Phase 10: oldest-session eviction so one account
   * can never accumulate unbounded concurrent sessions. Counts only
   * non-revoked, non-expired sessions (an already-dead row doesn't count
   * against the cap), and evicts the least-recently-active ones first —
   * the ones most likely to be a forgotten/abandoned device rather than
   * one in active use right now.
   */
  private async enforceSessionCap(userId: string): Promise<void> {
    const active = await this.systemPrisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true },
      // Steady state holds ≤ MAX_ACTIVE_SESSIONS_PER_USER live sessions; the far
      // higher MAX_AGGREGATION_ROWS is a hard backstop against an unbounded read.
      take: MAX_AGGREGATION_ROWS,
    });
    if (active.length < MAX_ACTIVE_SESSIONS_PER_USER) return;
    const toEvict = active.slice(MAX_ACTIVE_SESSIONS_PER_USER - 1).map((s) => s.id);
    await this.systemPrisma.userSession.updateMany({ where: { id: { in: toEvict } }, data: { revokedAt: new Date() } });
  }

  /**
   * Auth/Billing Platform Phase 10: a best-effort "have we seen this
   * IP + user-agent combination for this user before" check, used as a
   * fallback new-device signal for clients that don't send a
   * `deviceFingerprint` at all (the primary signal simply skips the alert
   * entirely when the field is omitted — see AuthService.proceedPastFirstFactor).
   * Deliberately independent of `isDeviceTrusted`/`trustDevice`: this never
   * skips an MFA challenge, it only decides whether the new-device-login
   * email is worth sending.
   */
  async hasKnownIpUserAgent(userId: string, ip: string | null | undefined, userAgent: string | null | undefined): Promise<boolean> {
    if (!ip || ip === 'unknown') return false;
    const existing = await this.systemPrisma.userSession.findFirst({
      where: { userId, ipAddress: ip, userAgent: userAgent ?? null },
      select: { id: true },
    });
    return !!existing;
  }

  /**
   * A3: have we ever recorded a session for this user from this device
   * fingerprint before? Used only to decide whether the new-device-login alert
   * is worth sending — a device seen before is not "new", even on a rotating IP.
   * Deliberately independent of `isDeviceTrusted`: a seen device is NOT trusted
   * for MFA-skip (that would be unsafe on a shared tablet), it just isn't news.
   */
  async hasSeenDeviceFingerprint(userId: string, deviceFingerprint: string): Promise<boolean> {
    const existing = await this.systemPrisma.userSession.findFirst({
      where: { userId, deviceFingerprint: this.hashFingerprint(deviceFingerprint) },
      select: { id: true },
    });
    return !!existing;
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
