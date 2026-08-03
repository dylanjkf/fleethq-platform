import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

/**
 * Platform Security Centre — real, aggregate security posture across every
 * tenant plus FleetHQ's own staff accounts: MFA adoption, currently-locked
 * customer accounts, accounts carrying failed-login attempts. All read
 * straight from columns that already exist (`mfaEnabledAt`, `lockedUntil`,
 * `failedLoginCount`) — no fabricated risk scores. Admin activity + permission
 * changes live in the immutable admin audit log (its own browse endpoint).
 */
@Injectable()
export class AdminSecurityService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  async overview() {
    const now = new Date();
    const [
      customerTotal,
      customerMfaEnabled,
      customerLocked,
      customerFailedLogins,
      adminTotal,
      adminMfaEnabled,
      lockedAccounts,
    ] = await Promise.all([
      this.adminPrisma.user.count({ where: { archivedAt: null } }),
      this.adminPrisma.user.count({ where: { archivedAt: null, mfaEnabledAt: { not: null } } }),
      this.adminPrisma.user.count({ where: { archivedAt: null, lockedUntil: { gt: now } } }),
      this.adminPrisma.user.count({ where: { archivedAt: null, failedLoginCount: { gt: 0 } } }),
      this.adminPrisma.adminUser.count({ where: { archivedAt: null } }),
      this.adminPrisma.adminUser.count({ where: { archivedAt: null, mfaEnabledAt: { not: null } } }),
      this.adminPrisma.user.findMany({
        where: { archivedAt: null, lockedUntil: { gt: now } },
        orderBy: { lockedUntil: 'desc' },
        take: 25,
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          lockedUntil: true,
          failedLoginCount: true,
          memberships: { where: { archivedAt: null }, take: 1, select: { company: { select: { id: true, name: true } } } },
        },
      }),
    ]);

    const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

    return {
      customerMfa: { enabled: customerMfaEnabled, total: customerTotal, adoptionPct: pct(customerMfaEnabled, customerTotal) },
      adminMfa: { enabled: adminMfaEnabled, total: adminTotal, adoptionPct: pct(adminMfaEnabled, adminTotal) },
      lockedCustomerAccounts: customerLocked,
      customersWithFailedLogins: customerFailedLogins,
      lockedAccounts: lockedAccounts.map((u) => ({
        id: u.id,
        username: u.username,
        fullName: u.fullName,
        email: u.email,
        lockedUntil: u.lockedUntil,
        failedLoginCount: u.failedLoginCount,
        organisation: u.memberships[0]?.company ?? null,
      })),
    };
  }
}
