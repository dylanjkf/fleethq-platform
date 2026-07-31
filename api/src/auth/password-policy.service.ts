import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { SystemPrismaService } from '../prisma/system-prisma.service';

/**
 * Password-reuse prevention (Auth/Billing Platform Phase 3,
 * 22-Auth-Billing-Platform/Overview.md). Deliberately a fixed, global rule —
 * not a per-company setting like `mfaRequired`/`passwordExpiryDays` — since a
 * single User account can belong to several companies at once and "whose
 * history-length policy applies" has no non-arbitrary answer; a reuse check
 * that's always on beats one that's configurable-and-often-off.
 *
 * Runs only on every *change* (reset, self-service change, expiry-forced
 * change) — never on initial account creation, which has nothing to compare
 * against yet.
 */
@Injectable()
export class PasswordPolicyService {
  private static readonly HISTORY_LIMIT = 5;

  constructor(private readonly systemPrisma: SystemPrismaService) {}

  /** Throws PASSWORD_REUSED if `newPassword` matches the current hash or any of the last HISTORY_LIMIT retired ones. */
  async assertNotReused(userId: string, newPassword: string, currentHash: string): Promise<void> {
    if (await bcrypt.compare(newPassword, currentHash)) {
      throw new BadRequestException({ code: 'PASSWORD_REUSED', message: 'Choose a password you haven’t used recently.' });
    }
    const history = await this.systemPrisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: PasswordPolicyService.HISTORY_LIMIT,
    });
    for (const entry of history) {
      if (await bcrypt.compare(newPassword, entry.passwordHash)) {
        throw new BadRequestException({ code: 'PASSWORD_REUSED', message: 'Choose a password you haven’t used recently.' });
      }
    }
  }

  /**
   * Call with the hash that's about to be overwritten, right before writing
   * the new one — this is what makes "history" mean "every hash that was
   * ever the active password", not just hashes chosen deliberately as a
   * decoy. Trims to the most recent HISTORY_LIMIT rows per user.
   */
  async recordPreviousHash(userId: string, previousHash: string): Promise<void> {
    await this.systemPrisma.passwordHistory.create({ data: { userId, passwordHash: previousHash } });
    const stale = await this.systemPrisma.passwordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: PasswordPolicyService.HISTORY_LIMIT,
      select: { id: true },
    });
    if (stale.length > 0) {
      await this.systemPrisma.passwordHistory.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }
}
