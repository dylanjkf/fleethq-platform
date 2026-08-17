import { randomInt } from 'crypto';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { resolveBcryptCost } from '../../common/security/bcrypt-cost';
import { AdminPrismaService } from '../../prisma/admin-prisma.service';
import { generateSecret, otpauthUrl, verifyTotp } from '../../auth/mfa/totp';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../../admin-audit/admin-audit.service';
import type { AdminAuthContext } from '../admin-auth.service';

const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_COUNT = 10;

/** Drop spaces from a submitted TOTP so a grouped "123 456" entry still verifies. */
function stripSpaces(code: string): string {
  return code.replace(/\s+/g, '');
}

interface AdminMfaUser {
  id: string;
  username: string;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  mfaBackupCodes: string[];
}

/**
 * TOTP MFA for FleetHQ staff — same algorithm/enrolment shape as the
 * customer MfaService (src/auth/mfa/mfa.service.ts), reusing its
 * dependency-free totp.ts, but operating on AdminUser via AdminPrismaService
 * (fleetos_admin) instead of User via SystemPrismaService (fleetos_auth) —
 * the two account types, and the two DB roles, must never cross.
 */
@Injectable()
export class AdminMfaService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private async requireUser(adminUserId: string): Promise<AdminMfaUser> {
    const user = await this.adminPrisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { id: true, username: true, mfaSecret: true, mfaEnabledAt: true, mfaBackupCodes: true },
    });
    if (!user) throw new UnauthorizedException({ code: 'ADMIN_USER_NOT_FOUND', message: 'Admin user not found.' });
    return user;
  }

  async beginEnrollment(adminUserId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.requireUser(adminUserId);
    if (user.mfaEnabledAt) {
      throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled. Disable it first to re-enrol.' });
    }
    const secret = generateSecret();
    await this.adminPrisma.adminUser.update({ where: { id: adminUserId }, data: { mfaSecret: secret } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.username, 'FleetHQ Admin') };
  }

  async confirmEnrollment(adminUserId: string, code: string, context: AdminAuthContext = {}): Promise<{ backupCodes: string[] }> {
    const user = await this.requireUser(adminUserId);
    if (user.mfaEnabledAt) {
      throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled.' });
    }
    if (!user.mfaSecret) {
      throw new BadRequestException({ code: 'MFA_NOT_STARTED', message: 'Start MFA setup before confirming a code.' });
    }
    if (!verifyTotp(user.mfaSecret, stripSpaces(code))) {
      // 400, NOT 401: this admin is already authenticated (they hold a valid
      // session token to reach this endpoint) — a wrong 6-digit code is bad
      // *input*, not a dead session. Returning 401 made the SPA's axios
      // interceptor treat it as "session expired", wipe the token and bounce
      // the admin all the way back to the username/password login mid-enrolment.
      throw new BadRequestException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect. Check your authenticator and try again.' });
    }
    const backupCodes = this.generateBackupCodes();
    const hashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(this.normalise(c), resolveBcryptCost())));
    await this.adminPrisma.adminUser.update({
      where: { id: adminUserId },
      data: { mfaEnabledAt: new Date(), mfaBackupCodes: hashes },
    });
    await this.audit.record({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.MFA_ENABLED,
      entityType: 'admin_user',
      entityId: adminUserId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { backupCodes };
  }

  async disable(adminUserId: string, code: string, context: AdminAuthContext = {}): Promise<void> {
    const user = await this.requireUser(adminUserId);
    if (!user.mfaEnabledAt) return;
    const result = await this.verifyChallenge(user, code);
    if (!result.ok) {
      // 400, not 401 — see confirmEnrollment: an authenticated admin submitting
      // a wrong disable code is bad input, not a revoked session.
      throw new BadRequestException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }
    if (result.usedBackupCode) {
      await this.audit.record({
        adminUserId,
        action: ADMIN_AUDIT_ACTIONS.MFA_BACKUP_CODE_USED,
        entityType: 'admin_user',
        entityId: adminUserId,
        ip: context.ip,
        userAgent: context.userAgent,
      });
    }
    await this.adminPrisma.adminUser.update({
      where: { id: adminUserId },
      data: { mfaSecret: null, mfaEnabledAt: null, mfaBackupCodes: [] },
    });
    await this.audit.record({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.MFA_DISABLED,
      entityType: 'admin_user',
      entityId: adminUserId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Regenerate the one-time backup codes for an admin who already has MFA on.
   * Verifies a current second factor (TOTP or an existing backup code) first,
   * then replaces the whole set — so lost/used codes can be rotated without
   * disabling and re-enrolling MFA. Returns the new codes exactly once.
   */
  async regenerateBackupCodes(adminUserId: string, code: string, context: AdminAuthContext = {}): Promise<{ backupCodes: string[] }> {
    const user = await this.requireUser(adminUserId);
    if (!user.mfaEnabledAt) {
      throw new BadRequestException({ code: 'MFA_NOT_ENABLED', message: 'Enable MFA before regenerating backup codes.' });
    }
    const result = await this.verifyChallenge(user, code);
    if (!result.ok) {
      // 400, not 401 — see confirmEnrollment.
      throw new BadRequestException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }
    const backupCodes = this.generateBackupCodes();
    const hashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(this.normalise(c), resolveBcryptCost())));
    await this.adminPrisma.adminUser.update({ where: { id: adminUserId }, data: { mfaBackupCodes: hashes } });
    await this.audit.record({
      adminUserId,
      action: ADMIN_AUDIT_ACTIONS.MFA_BACKUP_CODES_REGENERATED,
      entityType: 'admin_user',
      entityId: adminUserId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { backupCodes };
  }

  async verifyChallenge(user: AdminMfaUser, code: string): Promise<{ ok: boolean; usedBackupCode: boolean }> {
    if (!user.mfaSecret || !user.mfaEnabledAt) return { ok: false, usedBackupCode: false };
    // Authenticator apps display the 6 digits grouped ("123 456"); tolerate a
    // pasted/typed space so a genuinely-correct code isn't rejected. Backup
    // codes are whitespace/case-normalised separately by `normalise` below.
    if (verifyTotp(user.mfaSecret, stripSpaces(code))) return { ok: true, usedBackupCode: false };

    const normalised = this.normalise(code);
    for (const hash of user.mfaBackupCodes) {
      if (await bcrypt.compare(normalised, hash)) {
        const remaining = await Promise.all(
          user.mfaBackupCodes.map(async (h) => ((await bcrypt.compare(normalised, h)) ? null : h)),
        );
        await this.adminPrisma.adminUser.update({
          where: { id: user.id },
          data: { mfaBackupCodes: remaining.filter((h): h is string => h !== null) },
        });
        return { ok: true, usedBackupCode: true };
      }
    }
    return { ok: false, usedBackupCode: false };
  }

  private normalise(code: string): string {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private generateBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i += 1) {
      let raw = '';
      for (let j = 0; j < 8; j += 1) raw += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    return codes;
  }
}
