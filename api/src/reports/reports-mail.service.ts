import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../notifications/channels/notification-channel';
import type { ReportsService } from './reports.service';

/** The shape produced by ReportsService.operations — reused, not re-derived. */
export type OperationsReport = Awaited<ReturnType<ReportsService['operations']>>;

/**
 * Weekly operations report email — the email companion to the scheduled
 * `WeeklyReportService.sendWeeklyReport` in-app notification. Mirrors
 * `BillingMailService`'s shape: one method through the same
 * `NotificationChannel` abstraction (real SES when configured, log-only
 * otherwise) — no new email infrastructure. The numbers come straight from
 * `ReportsService.operations`; nothing is re-aggregated here.
 */
@Injectable()
export class ReportsMailService {
  constructor(
    @Inject(NOTIFICATION_CHANNEL) private readonly channel: NotificationChannel,
    private readonly config: ConfigService,
  ) {}

  private reportsLink(): string {
    return `${this.config.get<string>('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, '')}/reports`;
  }

  /** Human summary of the operations report, shared by the email body and the in-app notification. */
  static summaryLines(report: OperationsReport): string[] {
    const d = report.deliveries;
    const pct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
    return [
      `Deliveries: ${d.delivered} completed, ${d.failed} failed (${pct(d.deliveryRatePct)} delivery rate).`,
      `On-time: ${d.onTime.onTimeCount}/${d.onTime.assessed} within window (${pct(d.onTime.onTimeRatePct)}).`,
      `Pre-start checklists: ${report.checklists.completed} completed, ${report.checklists.withFailures} with defects.`,
      `Workshop: ${report.workshop.openJobs} open job${report.workshop.openJobs === 1 ? '' : 's'}.`,
      `Maintenance cost: $${report.cost.totalCost.toFixed(2)} across ${report.cost.jobsWithCost} job${report.cost.jobsWithCost === 1 ? '' : 's'}.`,
      `Fleet uptime: ${pct(report.uptime.fleetUptimePct)} of ${report.uptime.totalAssets} asset${report.uptime.totalAssets === 1 ? '' : 's'}.`,
    ];
  }

  async sendWeeklyReport(to: string, fullName: string, companyName: string, report: OperationsReport): Promise<void> {
    const from = report.range.from.toLocaleDateString('en-AU');
    const until = report.range.to.toLocaleDateString('en-AU');
    const lines = ReportsMailService.summaryLines(report);
    await this.channel.sendEmail({
      to,
      subject: `${companyName}'s FleetOS weekly report (${from} – ${until})`,
      body: `Hi ${fullName},\n\nHere is ${companyName}'s FleetOS operations summary for ${from} – ${until}:\n\n${lines
        .map((l) => `- ${l}`)
        .join('\n')}\n\nSee the full report with per-operator and cost breakdowns:\n\n${this.reportsLink()}`,
    });
  }
}
