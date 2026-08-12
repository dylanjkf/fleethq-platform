import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ComplianceService } from '../compliance/compliance.service';
import { MaintenanceSchedulesService } from '../maintenance-schedules/maintenance-schedules.service';
import { RetentionService } from '../retention/retention.service';
import { DashboardMetricsService } from '../dashboard-layouts/dashboard-metrics.service';
import { IntegrationSyncEngine } from '../integrations/integration-sync-engine.service';
import { BillingService } from '../billing/billing.service';
import { SignupService } from '../signup/signup.service';
import { WeeklyReportService } from '../reports/weekly-report.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DIGEST_TASK = 'notification_digest';
const COMPLIANCE_SWEEP_TASK = 'compliance_expiry_sweep';
const MAINTENANCE_SWEEP_TASK = 'maintenance_due_sweep';
const GPS_RETENTION_TASK = 'gps_retention_purge';
const STRIPE_EVENT_RETENTION_TASK = 'stripe_webhook_event_retention_purge';
const TRIAL_REMINDER_TASK = 'native_trial_ending_reminder';
const UTILISATION_SNAPSHOT_TASK = 'utilisation_snapshot';
const INTEGRATION_SYNC_TASK = 'integration_scheduled_sync';
const INTEGRATION_DEAD_LETTER_RETRY_TASK = 'integration_dead_letter_retry';
const SIGNUP_EXPIRY_TASK = 'signup_pending_expiry';
const SIGNUP_RECONCILE_TASK = 'signup_reconcile';
const WEEKLY_REPORT_TASK = 'weekly_operations_report';

/**
 * Dependency-free background scheduler. Deliberately not `@nestjs/schedule`
 * (which conflicts with this app's pinned NestJS versions) — a guarded
 * `setInterval` is the boring, proven equivalent for the handful of recurring
 * jobs we run today (compliance-expiry sweep, integration dead-letter retry,
 * signup pending-expiry and reconcile, and the other registered tasks), with no
 * new dependency.
 *
 * OFF by default: it only runs when `SCHEDULER_ENABLED=true`, and never under
 * tests. In a multi-instance deployment, enable it on exactly one instance (or
 * front it with a leader-election / external cron) so a task fires once, not
 * once per replica.
 *
 * Cross-tenant by nature (it iterates every company), so it enumerates ids via
 * the privileged read-only SystemPrismaService, then re-scopes to a single
 * tenant for each unit of work through the normal per-company service methods.
 *
 * Multi-replica safe: each tick is gated by a database lease (leader election),
 * so enabling the scheduler on every instance still fires each task once per
 * interval, not once per replica. No external coordinator needed.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly holderId = randomUUID();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly notifications: NotificationsService,
    private readonly compliance: ComplianceService,
    private readonly maintenanceSchedules: MaintenanceSchedulesService,
    private readonly retention: RetentionService,
    private readonly dashboardMetrics: DashboardMetricsService,
    private readonly integrationSyncEngine: IntegrationSyncEngine,
    private readonly billing: BillingService,
    private readonly signup: SignupService,
    private readonly weeklyReports: WeeklyReportService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<string>('SCHEDULER_ENABLED') === 'true' && process.env.NODE_ENV !== 'test';
    if (!enabled) {
      this.logger.log('Scheduler disabled (set SCHEDULER_ENABLED=true to enable — safe on every instance; a DB lease elects one leader per tick).');
      return;
    }
    const digestIntervalMs = Number(this.config.get<string>('SCHEDULER_DIGEST_INTERVAL_MS')) || DAY_MS;
    const complianceIntervalMs = Number(this.config.get<string>('SCHEDULER_COMPLIANCE_INTERVAL_MS')) || DAY_MS;
    const maintenanceIntervalMs = Number(this.config.get<string>('SCHEDULER_MAINTENANCE_INTERVAL_MS')) || DAY_MS;
    const retentionIntervalMs = Number(this.config.get<string>('SCHEDULER_RETENTION_INTERVAL_MS')) || DAY_MS;
    const trialReminderIntervalMs = Number(this.config.get<string>('SCHEDULER_TRIAL_REMINDER_INTERVAL_MS')) || DAY_MS;
    // Utilisation samples several times a day by default so each day's stored
    // figure is a real average, not one arbitrary reading; the (company, day)
    // row accumulates, so cadence just controls how many samples fold in.
    const utilisationIntervalMs = Number(this.config.get<string>('SCHEDULER_UTILISATION_INTERVAL_MS')) || 4 * HOUR_MS;
    // Integration Hub sweeps run far more often than the other daily jobs —
    // a scheduled connection's nextRunAt and a dead letter's backoff are both
    // measured in minutes, so a daily tick would make `scheduleCron`/retry
    // timing meaningless. Every 5 minutes is a reasonable default poll
    // granularity for a background sweep of this kind.
    const integrationSyncIntervalMs = Number(this.config.get<string>('SCHEDULER_INTEGRATION_SYNC_INTERVAL_MS')) || 5 * 60_000;
    const integrationDeadLetterIntervalMs = Number(this.config.get<string>('SCHEDULER_INTEGRATION_DEAD_LETTER_INTERVAL_MS')) || 5 * 60_000;
    // Abandoned self-serve signups (paid checkout never completed) get their
    // pending_signups row marked EXPIRED past its TTL. Hourly is ample — the
    // TTL itself is measured in hours, and expiry is just housekeeping so stale
    // rows don't accumulate and a re-signup with the same email isn't blocked.
    const signupExpiryIntervalMs = Number(this.config.get<string>('SCHEDULER_SIGNUP_EXPIRY_INTERVAL_MS')) || HOUR_MS;
    // Recovery net for a paid checkout whose provisioning webhook was missed or
    // kept failing (customer charged, no account). Runs more often than expiry —
    // a stuck paid signup is a live customer waiting to get in — but not so often
    // it hammers Stripe: every 15 minutes by default.
    const signupReconcileIntervalMs = Number(this.config.get<string>('SCHEDULER_SIGNUP_RECONCILE_INTERVAL_MS')) || 15 * 60_000;
    // The scheduler only supports fixed intervals, so "weekly" is a 7-day
    // interval anchored at boot (config-overridable). The report itself is
    // idempotent per company per week, so an off-by-a-tick anchor never
    // double-sends.
    const weeklyReportIntervalMs = Number(this.config.get<string>('SCHEDULER_WEEKLY_REPORT_INTERVAL_MS')) || WEEK_MS;
    this.logger.log(
      `Scheduler enabled — notification digest every ${Math.round(digestIntervalMs / 60000)} min, ` +
        `compliance-expiry sweep every ${Math.round(complianceIntervalMs / 60000)} min, ` +
        `maintenance-due sweep every ${Math.round(maintenanceIntervalMs / 60000)} min, ` +
        `GPS retention purge every ${Math.round(retentionIntervalMs / 60000)} min, ` +
        `Stripe webhook-ledger retention purge every ${Math.round(retentionIntervalMs / 60000)} min, ` +
        `native trial-ending reminder every ${Math.round(trialReminderIntervalMs / 60000)} min, ` +
        `utilisation snapshot every ${Math.round(utilisationIntervalMs / 60000)} min, ` +
        `integration sync every ${Math.round(integrationSyncIntervalMs / 60000)} min, ` +
        `integration dead-letter retry every ${Math.round(integrationDeadLetterIntervalMs / 60000)} min, ` +
        `pending-signup expiry every ${Math.round(signupExpiryIntervalMs / 60000)} min, ` +
        `signup reconciliation every ${Math.round(signupReconcileIntervalMs / 60000)} min, ` +
        `weekly operations report every ${Math.round(weeklyReportIntervalMs / 60000)} min (leader-elected).`,
    );
    this.timers.push(this.scheduleTask(DIGEST_TASK, digestIntervalMs, () => this.runNotificationDigests()));
    this.timers.push(this.scheduleTask(COMPLIANCE_SWEEP_TASK, complianceIntervalMs, () => this.runComplianceExpirySweeps()));
    this.timers.push(this.scheduleTask(MAINTENANCE_SWEEP_TASK, maintenanceIntervalMs, () => this.runMaintenanceDueSweeps()));
    this.timers.push(this.scheduleTask(GPS_RETENTION_TASK, retentionIntervalMs, () => this.retention.runGpsRetention()));
    this.timers.push(this.scheduleTask(STRIPE_EVENT_RETENTION_TASK, retentionIntervalMs, () => this.retention.purgeStripeWebhookEvents()));
    this.timers.push(this.scheduleTask(TRIAL_REMINDER_TASK, trialReminderIntervalMs, () => this.runTrialEndingReminders()));
    this.timers.push(this.scheduleTask(UTILISATION_SNAPSHOT_TASK, utilisationIntervalMs, () => this.runUtilisationSnapshots()));
    this.timers.push(this.scheduleTask(INTEGRATION_SYNC_TASK, integrationSyncIntervalMs, () => this.runIntegrationScheduledSyncs()));
    this.timers.push(this.scheduleTask(INTEGRATION_DEAD_LETTER_RETRY_TASK, integrationDeadLetterIntervalMs, () => this.runIntegrationDeadLetterRetries()));
    this.timers.push(this.scheduleTask(SIGNUP_EXPIRY_TASK, signupExpiryIntervalMs, () => this.runPendingSignupExpiry()));
    this.timers.push(this.scheduleTask(SIGNUP_RECONCILE_TASK, signupReconcileIntervalMs, () => this.runSignupReconciliation()));
    this.timers.push(this.scheduleTask(WEEKLY_REPORT_TASK, weeklyReportIntervalMs, () => this.runWeeklyReports()));
  }

  /**
   * Run `work` on `intervalMs`, but only on the instance that wins the task's
   * DB lease for that tick (leader election). The lease is held slightly under
   * the interval so the next tick can re-claim it.
   */
  private scheduleTask(task: string, intervalMs: number, work: () => Promise<unknown>): NodeJS.Timeout {
    const leaseSeconds = Math.max(60, Math.floor((intervalMs / 1000) * 0.9));
    return setInterval(() => {
      void (async () => {
        if (await this.tryAcquireLease(task, leaseSeconds)) await work();
        else this.logger.debug(`Skipping ${task} tick — another instance holds the lease.`);
      })();
    }, intervalMs);
  }

  /**
   * Atomically claim a task's lease if it's free or expired. One statement:
   * insert the lease, or take it over on conflict only when the current lease
   * has lapsed. Returns true iff this instance is the leader for the window.
   * Connection-pool safe (no session-scoped locks). Public for testing.
   */
  async tryAcquireLease(task: string, leaseSeconds: number): Promise<boolean> {
    const rows = await this.systemPrisma.$queryRaw<{ task: string }[]>`
      INSERT INTO scheduler_leases (task, locked_until, holder, updated_at)
      VALUES (${task}, now() + make_interval(secs => ${leaseSeconds}), ${this.holderId}, now())
      ON CONFLICT (task) DO UPDATE
        SET locked_until = EXCLUDED.locked_until, holder = EXCLUDED.holder, updated_at = now()
      WHERE scheduler_leases.locked_until < now()
      RETURNING task
    `;
    return rows.length > 0;
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Send each company's pending notification digest. Per-company failures are
   * logged and skipped so one tenant's problem can't stall the rest; the digest
   * itself is idempotent (it marks what it sends), so a retry next tick is safe.
   */
  async runNotificationDigests(): Promise<{ companies: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        await this.notifications.sendDigest(companyId);
      } catch (err) {
        failures += 1;
        this.logger.error(`Digest failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Digest run complete: ${companyIds.length} companies, ${failures} failures.`);
    return { companies: companyIds.length, failures };
  }

  /**
   * Send the native (no-card) free-trial ending reminder to companies whose
   * trial ends within the reminder window. Same cross-tenant shape as the other
   * sweeps: enumerate companies via the privileged read-only client, then
   * re-scope to each tenant through `BillingService.remindTrialEnding`, which is
   * idempotent (a company already reminded in this trial window is a no-op). One
   * tenant's failure is logged and skipped so it can't stall the rest.
   */
  async runTrialEndingReminders(): Promise<{ companies: number; reminded: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let reminded = 0;
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        if ((await this.billing.remindTrialEnding(companyId)) > 0) reminded += 1;
      } catch (err) {
        failures += 1;
        this.logger.error(`Trial-ending reminder failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Trial-ending reminder run complete: ${companyIds.length} companies, ${reminded} reminded, ${failures} failures.`);
    return { companies: companyIds.length, reminded, failures };
  }

  /**
   * Deliver each company's weekly operations report (in-app notification + email
   * to reports:view holders). Same cross-tenant shape as the other sweeps:
   * enumerate companies via the privileged read-only client, then re-scope to
   * each tenant through `WeeklyReportService.sendWeeklyReport`, which is
   * idempotent (one report per company per 7-day window, guarded by its
   * `reports.weekly_summary` marker) so a re-run in the same window is a no-op.
   * One tenant's failure is logged and skipped so it can't stall the rest.
   */
  async runWeeklyReports(): Promise<{ companies: number; sent: number; recipients: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let sent = 0;
    let recipients = 0;
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.weeklyReports.sendWeeklyReport(companyId);
        if (result.sent) {
          sent += 1;
          recipients += result.recipients;
        }
      } catch (err) {
        failures += 1;
        this.logger.error(`Weekly report failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Weekly report run complete: ${companyIds.length} companies, ${sent} sent, ${recipients} recipients, ${failures} failures.`);
    return { companies: companyIds.length, sent, recipients, failures };
  }

  /**
   * Raise per-company compliance-expiry alerts (documents newly expiring soon or
   * expired). Same cross-tenant shape as the digest: enumerate companies via the
   * privileged read-only client, then re-scope to each tenant through the
   * per-company sweep, which is idempotent (its alert marks make a re-run a
   * no-op). One tenant's failure is logged and skipped so it can't stall the
   * rest.
   */
  async runComplianceExpirySweeps(): Promise<{ companies: number; expiring: number; expired: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let expiring = 0;
    let expired = 0;
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.compliance.sweepExpiries(companyId);
        expiring += result.expiring;
        expired += result.expired;
      } catch (err) {
        failures += 1;
        this.logger.error(`Compliance sweep failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Compliance sweep complete: ${companyIds.length} companies, ${expiring} expiring, ${expired} expired, ${failures} failures.`);
    return { companies: companyIds.length, expiring, expired, failures };
  }

  /**
   * Raise per-company maintenance-due alerts (per-asset plans newly due-soon or
   * overdue). Same cross-tenant shape as the compliance sweep: enumerate
   * companies via the privileged read-only client, then re-scope to each tenant
   * through the per-company sweep, which is idempotent (its alert marks make a
   * re-run a no-op). One tenant's failure is logged and skipped so it can't
   * stall the rest.
   */
  async runMaintenanceDueSweeps(): Promise<{ companies: number; due: number; overdue: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let due = 0;
    let overdue = 0;
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.maintenanceSchedules.sweepDue(companyId);
        due += result.due;
        overdue += result.overdue;
      } catch (err) {
        failures += 1;
        this.logger.error(`Maintenance sweep failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Maintenance sweep complete: ${companyIds.length} companies, ${due} due, ${overdue} overdue, ${failures} failures.`);
    return { companies: companyIds.length, due, overdue, failures };
  }

  /**
   * Fold the current utilisation reading into each company's snapshot for today
   * (assets on an active job ÷ active assets). Same cross-tenant shape as the
   * other sweeps; the per-company upsert is idempotent-by-accumulation, so a
   * re-run in the same window just adds another sample. One tenant's failure is
   * logged and skipped.
   */
  async runUtilisationSnapshots(): Promise<{ companies: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        await this.dashboardMetrics.recordSnapshot(companyId);
      } catch (err) {
        failures += 1;
        this.logger.error(`Utilisation snapshot failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Utilisation snapshot complete: ${companyIds.length} companies, ${failures} failures.`);
    return { companies: companyIds.length, failures };
  }

  /**
   * Runs every enabled IntegrationConnection whose `nextRunAt` has arrived,
   * per company (same cross-tenant shape as the other sweeps). One
   * connection's failure is logged and skipped — it still gets its
   * `nextRunAt` advanced (inside runDueScheduledSyncsForCompany) so a broken
   * connector can't fire every tick forever.
   */
  async runIntegrationScheduledSyncs(): Promise<{ companies: number; ran: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let ran = 0;
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.integrationSyncEngine.runDueScheduledSyncsForCompany(companyId);
        ran += result.ran;
        failures += result.failures;
      } catch (err) {
        failures += 1;
        this.logger.error(`Integration scheduled-sync sweep failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Integration scheduled-sync sweep complete: ${companyIds.length} companies, ${ran} run(s), ${failures} failures.`);
    return { companies: companyIds.length, ran, failures };
  }

  /**
   * Retries every IntegrationDeadLetter whose backoff has elapsed, per
   * company. Each row is retried individually inside
   * retryDueDeadLettersForCompany, so one row's failure never blocks the rest.
   */
  async runIntegrationDeadLetterRetries(): Promise<{ companies: number; retried: number; resolved: number; failed: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let retried = 0;
    let resolved = 0;
    let failed = 0;
    for (const companyId of companyIds) {
      try {
        const result = await this.integrationSyncEngine.retryDueDeadLettersForCompany(companyId);
        retried += result.retried;
        resolved += result.resolved;
        failed += result.failed;
      } catch (err) {
        failed += 1;
        this.logger.error(`Integration dead-letter retry sweep failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`Integration dead-letter retry sweep complete: ${companyIds.length} companies, ${retried} retried, ${resolved} resolved, ${failed} failed.`);
    return { companies: companyIds.length, retried, resolved, failed };
  }

  /**
   * Mark abandoned self-serve signups (paid checkout never completed) as EXPIRED
   * once past their TTL. Not per-tenant — no company exists until payment
   * succeeds — so this is a single sweep over the staging table via the
   * privileged client. Idempotent (only PENDING rows past expiry are touched).
   */
  async runPendingSignupExpiry(): Promise<{ expired: number }> {
    const expired = await this.signup.expireStalePendingSignups();
    return { expired };
  }

  /**
   * Recover paid-but-unprovisioned signups (a missed/failed provisioning webhook
   * left a paying customer with no account) and raise a staff alert for any that
   * still can't be provisioned. Single cross-tenant sweep via the signup service;
   * a no-op when Stripe isn't configured.
   */
  async runSignupReconciliation(): Promise<{ checked: number; recovered: number; failed: number }> {
    return this.signup.reconcileStuckSignups();
  }
}
