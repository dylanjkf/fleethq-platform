import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { resolveBcryptCost } from '../common/security/bcrypt-cost';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuthTokensService } from './admin-auth-tokens.service';
import { AdminAuthMailService } from './admin-auth-mail.service';
import { AdminAuthService, AdminAuthContext } from './admin-auth.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { isStrongPassword } from '../common/validators/is-strong-password.validator';

/**
 * Self-service password recovery for FleetHQ staff admins — the admin-console
 * mirror of the customer-side AuthRecoveryService. Kept in its own service (as
 * the customer side does) so the login/session decision tree in
 * AdminAuthService stays focused. The security posture is copied verbatim from
 * the proven customer flow, only re-pointed at the admin user table / token
 * store / session revocation:
 *
 *  - forgotPassword is silent and non-enumerating (no user / no email → do
 *    nothing, disclose nothing);
 *  - resetPassword consumes a single-use, hashed, TTL'd token, enforces the
 *    same password policy the admin change-password path uses, bcrypt-hashes,
 *    bumps tokenVersion to kill every existing admin JWT, revokes all the
 *    admin's session rows, clears any lockout, and invalidates outstanding
 *    reset tokens.
 */
@Injectable()
export class AdminAuthRecoveryService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly tokens: AdminAuthTokensService,
    private readonly mail: AdminAuthMailService,
    private readonly adminAuth: AdminAuthService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Both username and email are unique on AdminUser, so either identifies at most one admin. */
  async findAdminByIdentifier(identifier: string) {
    const byUsername = await this.adminPrisma.adminUser.findUnique({ where: { username: identifier } });
    if (byUsername) return byUsername;
    return this.adminPrisma.adminUser.findUnique({ where: { email: identifier } });
  }

  /**
   * Always resolves the same way regardless of whether the admin exists — so
   * this endpoint can't be used to probe who has a FleetHQ staff account. The
   * email is only sent when there's a real, non-archived admin with an address
   * on file (AdminUser.email is required, but an archived/disabled admin is
   * deliberately skipped).
   */
  async forgotPassword(identifier: string): Promise<void> {
    const admin = await this.findAdminByIdentifier(identifier);
    if (!admin || admin.archivedAt || !admin.email) return;
    const token = await this.tokens.issue(admin.id, 'PASSWORD_RESET');
    await this.mail.sendPasswordReset(admin.email, admin.fullName, token);
  }

  async resetPassword(token: string, newPassword: string, context: AdminAuthContext = {}): Promise<void> {
    const adminUserId = await this.tokens.consume(token, 'PASSWORD_RESET');
    if (!adminUserId) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'This reset link is invalid or has expired.' });
    }
    const admin = await this.adminPrisma.adminUser.findUniqueOrThrow({ where: { id: adminUserId } });

    // Same policy as AdminAuthService.changePassword: shared strength rule plus
    // a no-reuse-of-current check (the admin path has no breach/history store).
    if (!isStrongPassword(newPassword)) {
      throw new BadRequestException({
        code: 'WEAK_PASSWORD',
        message: 'Password must be at least 8 characters and include all four of: lowercase, uppercase, a number, and a symbol.',
      });
    }
    if (await bcrypt.compare(newPassword, admin.passwordHash)) {
      throw new BadRequestException({ code: 'PASSWORD_REUSED', message: 'Choose a password different from your current one.' });
    }

    await this.adminPrisma.adminUser.update({
      where: { id: adminUserId },
      // A completed reset clears any forced-reset obligation and any lockout so
      // the admin can sign in immediately, and bumps tokenVersion so every
      // session issued before the reset is revoked at once (JwtStrategy rejects
      // a stale `tv`).
      data: {
        passwordHash: await bcrypt.hash(newPassword, resolveBcryptCost()),
        passwordChangedAt: new Date(),
        mustResetPassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        tokenVersion: { increment: 1 },
      },
    });

    // Invalidate any other outstanding reset links, and flip the session rows so
    // listSessions doesn't keep showing devices that look "active" and aren't.
    await this.tokens.invalidateAll(adminUserId, 'PASSWORD_RESET');
    await this.adminAuth.revokeAllSessions(adminUserId);

    await this.audit.record({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ADMIN_USER_PASSWORD_RESET,
      entityType: 'admin_user',
      entityId: adminUserId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    if (admin.email) {
      void this.mail.sendPasswordChanged(admin.email, admin.fullName).catch(() => undefined);
    }
  }
}
