import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuthTokensService } from './auth-tokens.service';
import { AuthMailService } from './auth-mail.service';
import { AuthSessionsService } from './auth-sessions.service';
import { PasswordPolicyService } from './password-policy.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';

/**
 * Account recovery — email verification, password reset, and (Auth/Billing
 * Platform Phase 3) self-service password change — split out of AuthService
 * (Phase 2) purely to keep that file under this repo's line-count lint rule;
 * these are self-contained password/email flows, not part of the login
 * decision tree itself. Still used by AuthService (login()/requestMagicLink()
 * need `findUserByIdentifier`) and directly by AuthController.
 */
@Injectable()
export class AuthRecoveryService {
  constructor(
    private readonly systemPrisma: SystemPrismaService,
    private readonly authTokens: AuthTokensService,
    private readonly mail: AuthMailService,
    private readonly sessions: AuthSessionsService,
    private readonly passwordPolicy: PasswordPolicyService,
    private readonly audit: AuditService,
  ) {}

  /** Username is unique; email is not (nullable, shared-family addresses), so an email match takes the most recently active account for it. */
  async findUserByIdentifier(identifier: string) {
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
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.passwordPolicy.assertNotReused(userId, newPassword, user.passwordHash);
    await this.passwordPolicy.recordPreviousHash(userId, user.passwordHash);
    await this.systemPrisma.user.update({
      where: { id: userId },
      // A completed reset also proves control of the mailbox, so mark the email
      // verified, and clear any lockout so the user can sign in immediately.
      // Bump tokenVersion so every session issued before the reset is revoked
      // at once (a reset is exactly when you want existing sessions killed).
      data: {
        passwordHash: await bcrypt.hash(newPassword, 10),
        passwordChangedAt: new Date(),
        emailVerifiedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
    });
    await this.authTokens.invalidateAll(userId, 'PASSWORD_RESET');
    // tokenVersion alone already blocks every existing JWT (JwtStrategy
    // rejects a stale `tv`), but revoke the session rows too so listSessions
    // doesn't keep showing devices that look "active" and aren't.
    await this.sessions.revokeAllSessions(userId);
    void this.audit.recordSystem({ action: AUDIT_ACTIONS.PASSWORD_RESET, actorUserId: userId, targetType: 'user', targetId: userId });
  }

  /**
   * Self-service change while already logged in — requires knowledge of the
   * current password (unlike resetPassword's emailed-token proof). Unlike a
   * reset, this doesn't bump tokenVersion or revoke other sessions: the
   * caller already proved they're the legitimate account holder by supplying
   * the current password, so there's no "possible compromise" to contain.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.systemPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'That current password is incorrect.' });
    }
    await this.passwordPolicy.assertNotReused(userId, newPassword, user.passwordHash);
    await this.passwordPolicy.recordPreviousHash(userId, user.passwordHash);
    await this.systemPrisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), passwordChangedAt: new Date() },
    });
    void this.audit.recordSystem({ action: AUDIT_ACTIONS.PASSWORD_CHANGED, actorUserId: userId, actorLabel: user.username, targetType: 'user', targetId: userId });
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.authTokens.consume(token, 'EMAIL_VERIFY');
    if (!userId) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This verification link is invalid or has expired.' });
    }
    await this.systemPrisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  }

  /** Also always resolves to `{ ok: true }` at the controller (no enumeration). */
  async resendVerification(identifier: string): Promise<void> {
    const user = await this.findUserByIdentifier(identifier);
    if (!user || user.archivedAt || !user.email || user.emailVerifiedAt) return;
    const token = await this.authTokens.issue(user.id, 'EMAIL_VERIFY');
    await this.mail.sendVerification(user.email, user.fullName, token);
  }
}
