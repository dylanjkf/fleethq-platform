import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { ReportsService } from './reports.service';
import { ReportsMailService } from './reports-mail.service';
import { buildWeeklyReportPdf } from './weekly-report-pdf';

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

      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, weeklyReportRecipients: true } });

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
      return { companyName: company.name, holders, configured: company.weeklyReportRecipients };
    });

    if (!result) return { sent: false, recipients: 0 };

    // Effective email targets (Part 4): if the company has configured a
    // recipient list, the report email goes to exactly those addresses;
    // otherwise it falls back to every reports:view holder with an email (the
    // prior behaviour), so the main contacts are covered by default. The in-app
    // notification above always goes to reports:view holders regardless.
    const targets: { email: string; name: string }[] =
      result.configured.length > 0
        ? result.configured.map((email) => ({ email, name: result.companyName }))
        : result.holders.filter((h) => h.email).map((h) => ({ email: h.email as string, name: h.fullName }));

    // One PDF per run (Part 4) — the same attachment for every recipient. Built
    // from the SAME computed report the email body summarises, so the attachment
    // can never disagree with the numbers in the message.
    let pdf: { data: Buffer; filename: string } | null = null;
    try {
      pdf = await buildWeeklyReportPdf(result.companyName, report, now);
    } catch (err) {
      this.logger.warn(`Could not render the weekly report PDF: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Sent after the transaction commits — a channel failure must never roll
    // back the in-app notification that makes this idempotent.
    let recipients = 0;
    for (const target of targets) {
      recipients += 1;
      void this.reportsMail
        .sendWeeklyReport(target.email, target.name, result.companyName, report, pdf)
        .catch((err) => this.logger.warn(`Failed to send a weekly report email: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { sent: true, recipients };
  }

  /**
   * The weekly-report recipient list for a company (Part 4). Returns the
   * configured addresses plus whether the company is still on the default
   * (empty list → reports:view holders receive it). Company-admin editable.
   */
  async getRecipients(companyId: string): Promise<{ recipients: string[]; usingDefault: boolean }> {
    const company = await this.prisma.withTenant(companyId, (tx) =>
      tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { weeklyReportRecipients: true } }),
    );
    return { recipients: company.weeklyReportRecipients, usingDefault: company.weeklyReportRecipients.length === 0 };
  }

  /** Add an email to the weekly-report recipient list (idempotent, case-normalised). */
  async addRecipient(companyId: string, email: string): Promise<{ recipients: string[] }> {
    const normalised = email.trim().toLowerCase();
    return this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { weeklyReportRecipients: true } });
      if (company.weeklyReportRecipients.includes(normalised)) return { recipients: company.weeklyReportRecipients };
      if (company.weeklyReportRecipients.length >= 50) {
        throw new BadRequestException({ code: 'TOO_MANY_RECIPIENTS', message: 'A company can have at most 50 weekly-report recipients.' });
      }
      const recipients = [...company.weeklyReportRecipients, normalised];
      await tx.company.update({ where: { id: companyId }, data: { weeklyReportRecipients: recipients } });
      return { recipients };
    });
  }

  /** Remove an email from the weekly-report recipient list. */
  async removeRecipient(companyId: string, email: string): Promise<{ recipients: string[] }> {
    const normalised = email.trim().toLowerCase();
    return this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { weeklyReportRecipients: true } });
      const recipients = company.weeklyReportRecipients.filter((e) => e !== normalised);
      await tx.company.update({ where: { id: companyId }, data: { weeklyReportRecipients: recipients } });
      return { recipients };
    });
  }
}
