import { randomInt } from 'crypto';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { SystemPrismaService } from '../../prisma/system-prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../../audit/audit.service';
import { generateSecret, otpauthUrl, verifyTotp } from './totp';

/** Recovery codes: readable, unambiguous alphabet (no 0/O/1/I), grouped 4-4. */
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_COUNT = 10;

interface MfaUser {
  id: string;
  username: string;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  mfaBackupCodes: string[];
}

/**
 * TOTP multi-factor auth: enrolment (setup → confirm), disable, and the
 * login-time challenge check. Enrolment is a two-step commit — a secret is
 * stored as *pending* on setup and MFA only becomes active (`mfaEnabledAt`)
 * once the user proves they can produce a code from it, so a half-finished
 * enrolment can never lock anyone out. All writes run through the pre-tenant
 * `fleetos_auth` role (the login path has no company context).
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly systemPrisma: SystemPrismaService,
    private readonly audit: AuditService,
  ) {}

  private async requireUser(userId: string): Promise<MfaUser> {
    const user = await this.systemPrisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, mfaSecret: true, mfaEnabledAt: true, mfaBackupCodes: true },
    });
    if (!user) throw new UnauthorizedException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    return user;
  }

  /** Step 1: issue a fresh secret + otpauth URI for the authenticator app. */
  async beginEnrollment(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.requireUser(userId);
    if (user.mfaEnabledAt) {
      throw new ConflictException({ code: 'MFA_ALREADY_ENABLED', message: 'MFA is already enabled. Disable it first to re-enrol.' });
    }
    const secret = generateSecret();
    // Stored as pending — not enforced at login until confirmEnrollment sets mfaEnabledAt.
    await this.systemPrisma.user.update({ where: { id: userId }, data: { mfaSecret: secret } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.username) };
  }

  /** Step 2: verify a code from the pending secret, activate MFA, return one-time backup codes. */
  async confirmEnrollment(userId: string, code: string): Promise<{ backupCodes: string[] }> {
    const user = await this.requireUser(userId);
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
    await this.systemPrisma.user.update({
      where: { id: userId },
      data: { mfaEnabledAt: new Date(), mfaBackupCodes: hashes },
    });
    void this.audit.recordSystem({ action: AUDIT_ACTIONS.MFA_ENABLED, actorUserId: userId, actorLabel: user.username, targetType: 'user', targetId: userId });
    return { backupCodes };
  }

  /** Turn MFA off — requires a current TOTP or a backup code, so a hijacked session can't silently disable it. */
  async disable(userId: string, code: string): Promise<void> {
    const user = await this.requireUser(userId);
    if (!user.mfaEnabledAt) return; // already off — idempotent
    const result = await this.verifyChallenge(user, code);
    if (!result.ok) {
      throw new UnauthorizedException({ code: 'MFA_CODE_INVALID', message: 'That code is incorrect.' });
    }
    await this.systemPrisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaEnabledAt: null, mfaBackupCodes: [] },
    });
    void this.audit.recordSystem({ action: AUDIT_ACTIONS.MFA_DISABLED, actorUserId: userId, actorLabel: user.username, targetType: 'user', targetId: userId });
  }

  /**
   * Verify a login/second-factor code against the user's TOTP secret, falling
   * back to a single-use backup code (which is then consumed). Used by both the
   * login MFA challenge and `disable`.
   */
  async verifyChallenge(user: MfaUser, code: string): Promise<{ ok: boolean; usedBackupCode: boolean }> {
    if (!user.mfaSecret || !user.mfaEnabledAt) return { ok: false, usedBackupCode: false };
    if (verifyTotp(user.mfaSecret, code)) return { ok: true, usedBackupCode: false };

    // Backup-code path: constant-work compare against each remaining hash.
    const normalised = this.normalise(code);
    for (const hash of user.mfaBackupCodes) {
      if (await bcrypt.compare(normalised, hash)) {
        const remaining = await Promise.all(
          user.mfaBackupCodes.map(async (h) => ((await bcrypt.compare(normalised, h)) ? null : h)),
        );
        await this.systemPrisma.user.update({
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
