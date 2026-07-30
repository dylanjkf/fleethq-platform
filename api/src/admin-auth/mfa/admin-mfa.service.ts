import { randomInt } from 'crypto';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminPrismaService } from '../../prisma/admin-prisma.service';
import { generateSecret, otpauthUrl, verifyTotp } from '../../auth/mfa/totp';

const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_COUNT = 10;

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
  constructor(private readonly adminPrisma: AdminPrismaService) {}

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

  async confirmEnrollment(adminUserId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.requireUser(adminUserId);
    if (user.mfaEnabledAt) {
      throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled.' });
    }
    if (!user.mfaSecret) {
      throw new BadRequestException({ code: 'MFA_NOT_STARTED', message: 'Start MFA setup before confirming a code.' });
    }
    if (!verifyTotp(user.mfaSecret, code)) {
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect. Check your authenticator and try again.' });
    }
    const backupCodes = this.generateBackupCodes();
    const hashes = await Promise.all(backupCodes.map((c) => bcrypt.hash(this.normalise(c), 10)));
    await this.adminPrisma.adminUser.update({
      where: { id: adminUserId },
      data: { mfaEnabledAt: new Date(), mfaBackupCodes: hashes },
    });
    return { backupCodes };
  }

  async disable(adminUserId: string, code: string): Promise<void> {
    const user = await this.requireUser(adminUserId);
    if (!user.mfaEnabledAt) return;
    const result = await this.verifyChallenge(user, code);
    if (!result.ok) {
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }
    await this.adminPrisma.adminUser.update({
      where: { id: adminUserId },
      data: { mfaSecret: null, mfaEnabledAt: null, mfaBackupCodes: [] },
    });
  }

  async verifyChallenge(user: AdminMfaUser, code: string): Promise<{ ok: boolean; usedBackupCode: boolean }> {
    if (!user.mfaSecret || !user.mfaEnabledAt) return { ok: false, usedBackupCode: false };
    if (verifyTotp(user.mfaSecret, code)) return { ok: true, usedBackupCode: false };

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
