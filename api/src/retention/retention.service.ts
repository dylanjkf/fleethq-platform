import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default GPS breadcrumb retention: 18 months. Location history is personal
 *  information, so it is not kept indefinitely (data-retention policy §4). */
const DEFAULT_GPS_RETENTION_DAYS = 540;
/** Default Stripe webhook idempotency-ledger retention: 90 days. The ledger only
 *  needs to span Stripe's own redelivery/retry window (days), not forever — an
 *  unbounded table is the concern, so anything comfortably past that window is
 *  safe to purge. */
const DEFAULT_STRIPE_EVENT_RETENTION_DAYS = 90;

/**
 * Data-retention enforcement (ISMS data-retention policy / ISO A.8.10). The
 * append-only high-growth tables must not accumulate personal data forever;
 * `gps_pings` (raw location breadcrumbs) is the privacy-critical one and is
 * purged past a configurable retention floor.
 *
 * Runs per-tenant through `withTenant`, so the delete is RLS-scoped to one
 * company at a time (the low-privilege runtime role already holds DELETE on
 * gps_pings; no broader grant is introduced). The current position cached on
 * the device/operator rows is untouched — only the historical trail is trimmed.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly config: ConfigService,
  ) {}

  private gpsRetentionMs(): number {
    const days = Number(this.config.get<string>('GPS_PING_RETENTION_DAYS')) || DEFAULT_GPS_RETENTION_DAYS;
    return days * DAY_MS;
  }

  private stripeEventRetentionMs(): number {
    const days = Number(this.config.get<string>('STRIPE_WEBHOOK_EVENT_RETENTION_DAYS')) || DEFAULT_STRIPE_EVENT_RETENTION_DAYS;
    return days * DAY_MS;
  }

  /**
   * Purge Stripe webhook idempotency-ledger rows older than the retention floor.
   * Unlike the GPS purge this is a single global (non-tenant) table with no RLS,
   * so it runs once via the privileged `fleetos_auth` role (SystemPrismaService)
   * — the same role that writes the ledger in `BillingService.alreadyProcessed`
   * — rather than per-company. Returns the number of rows deleted.
   */
  async purgeStripeWebhookEvents(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.stripeEventRetentionMs());
    const { count } = await this.systemPrisma.stripeWebhookEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    this.logger.log(`Stripe webhook event ledger purge complete: ${count} rows older than ${cutoff.toISOString()} deleted.`);
    return count;
  }

  /** Delete one company's GPS breadcrumbs older than the retention floor. */
  async purgeCompanyGpsPings(companyId: string, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.gpsRetentionMs());
    return this.prisma.withTenant(companyId, async (tx) => {
      const { count } = await tx.gpsPing.deleteMany({ where: { recordedAt: { lt: cutoff } } });
      return count;
    });
  }

  /**
   * Purge expired GPS breadcrumbs across every active company. Same cross-tenant
   * shape as the compliance sweep: enumerate ids via the privileged read-only
   * client, then re-scope to each tenant. One tenant's failure is logged and
   * skipped so it can't stall the rest.
   */
  async runGpsRetention(now: Date = new Date()): Promise<{ companies: number; deleted: number; failures: number }> {
    const companyIds = await this.systemPrisma.listActiveCompanyIds();
    let deleted = 0;
    let failures = 0;
    for (const companyId of companyIds) {
      try {
        deleted += await this.purgeCompanyGpsPings(companyId, now);
      } catch (err) {
        failures += 1;
        this.logger.error(`GPS retention purge failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`GPS retention purge complete: ${companyIds.length} companies, ${deleted} breadcrumbs deleted, ${failures} failures.`);
    return { companies: companyIds.length, deleted, failures };
  }
}
