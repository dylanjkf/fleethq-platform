import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from './reports.service';
import { ReportsMailService } from './reports-mail.service';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const WEEKLY_REPORT_NOTIFICATION_TYPE = 'reports.weekly_summary';

/**
 * The scheduled weekly operations report — an automated 7-day summary emailed to
 * the people who can already see Reports, plus an in-app notification, so it
 * lands without anyone logging in. Content is pulled straight from
 * `ReportsService.operations` (delivery/on-time/checklist/workshop/cost/uptime),
 * so there is no parallel aggregation SQL here.
 *
 * Idempotent per company per week: a `reports.weekly_summary` notification
 * created within the last 7 days is the "already sent this week" marker (same
 * approach as `BillingService.remindTrialEnding`), so a re-run in the same
 * window is a no-op. Recipients are `reports:view` holders — exactly the
 * permission the Reports endpoints require — and holders without an email
 * address are skipped (username is a login handle, not an inbox), matching the
 * digest convention.
 */
@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly reportsMail: ReportsMailService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Build this week's operations report and deliver it (in-app + email) to
   * `reports:view` holders. Returns whether a report was sent this run and how
   * many recipients it reached. A second call within the same 7-day window
   * returns `{ sent: false, recipients: 0 }` and does nothing.
   */
  async sendWeeklyReport(companyId: string, now: Date = new Date()): Promise<{ sent: boolean; recipients: number }> {
    // Computed in its own tenant-scoped read before the marker transaction —
    // `operations` reuses the existing Reports aggregation (default 7-day window).
    const report = await this.reports.operations(companyId, {});

    const result = await this.prisma.withTenant(companyId, async (tx) => {
      // Idempotency: one weekly report per company per week.
      const windowStart = new Date(now.getTime() - WEEK_MS);
      const already = await tx.notification.findFirst({
        where: { type: WEEKLY_REPORT_NOTIFICATION_TYPE, createdAt: { gte: windowStart } },
        select: { id: true },
      });
      if (already) return null;

      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });

      const d = report.deliveries;
      const summary = `${d.delivered} delivered, ${d.failed} failed${
        d.deliveryRatePct === null ? '' : ` (${d.deliveryRatePct}%)`
      }; ${report.checklists.completed} checklists; ${report.workshop.openJobs} open workshop jobs.`;
      await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.REPORTS_VIEW, {
        type: WEEKLY_REPORT_NOTIFICATION_TYPE,
        title: 'Your weekly fleet report is ready',
        body: `Last 7 days: ${summary}`,
        linkPath: '/reports',
      });
      const holders = await this.notifications.getPermissionHolders(tx, PERMISSIONS.REPORTS_VIEW);
      return { companyName: company.name, holders };
    });

    if (!result) return { sent: false, recipients: 0 };

    // Sent after the transaction commits — a channel failure must never roll
    // back the in-app notification that makes this idempotent. Holders without
    // an email address still got the in-app notification.
    let recipients = 0;
    for (const holder of result.holders) {
      if (!holder.email) continue;
      recipients += 1;
      void this.reportsMail
        .sendWeeklyReport(holder.email, holder.fullName, result.companyName, report)
        .catch((err) => this.logger.warn(`Failed to send a weekly report email: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { sent: true, recipients };
  }
}
