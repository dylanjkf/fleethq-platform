import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

const TRIAL_EXPIRY_DAYS = 7;

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}
function startOfUtcToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AdminAlert {
  key: string;
  severity: AlertSeverity;
  title: string;
  count: number;
  href: string;
}

/**
 * The admin alerts feed — a real, aggregate "what needs attention right now"
 * derived entirely from live data (expiring trials, suspended orgs, locked
 * accounts, failed inspections today, open defects). Each alert carries a count
 * and a deep link into the console surface that resolves it. No alert appears
 * with a zero count. Fabricated infra alerts (webhook failures, storage limits)
 * that have no data source in this codebase are deliberately omitted.
 */
@Injectable()
export class AdminNotificationsService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  async list(): Promise<{ alerts: AdminAlert[]; total: number }> {
    const now = new Date();
    const today = startOfUtcToday();

    const [expiringTrials, suspendedOrgs, lockedAccounts, failedInspectionsToday, openDefects] = await Promise.all([
      this.adminPrisma.company.count({ where: { archivedAt: null, trialEndsAt: { gte: now, lte: daysFromNow(TRIAL_EXPIRY_DAYS) } } }),
      this.adminPrisma.company.count({ where: { archivedAt: null, suspendedAt: { not: null } } }),
      this.adminPrisma.user.count({ where: { archivedAt: null, lockedUntil: { gt: now } } }),
      this.adminPrisma.checklistSubmission.count({ where: { hasFailures: true, submittedAt: { gte: today } } }),
      this.adminPrisma.maintenanceJob.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'PARTS_PENDING'] } } }),
    ]);

    const candidates: AdminAlert[] = [
      { key: 'trials_expiring', severity: 'warning', title: `${expiringTrials} trial(s) expiring within ${TRIAL_EXPIRY_DAYS} days`, count: expiringTrials, href: '/organisations?status=active' },
      { key: 'orgs_suspended', severity: 'critical', title: `${suspendedOrgs} suspended organisation(s)`, count: suspendedOrgs, href: '/organisations?status=suspended' },
      { key: 'accounts_locked', severity: 'warning', title: `${lockedAccounts} locked customer account(s)`, count: lockedAccounts, href: '/security' },
      { key: 'failed_inspections_today', severity: 'warning', title: `${failedInspectionsToday} failed inspection(s) today`, count: failedInspectionsToday, href: '/inspections' },
      { key: 'open_defects', severity: 'info', title: `${openDefects} open defect(s)`, count: openDefects, href: '/maintenance' },
    ];

    const alerts = candidates.filter((a) => a.count > 0);
    return { alerts, total: alerts.reduce((sum, a) => sum + a.count, 0) };
  }
}
