import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { BillingService } from '../billing/billing.service';
import { PAID_TIERS } from '../billing/plans';

/** Best-effort churn proxy: Company has no `cancelledAt` column, so this uses
 *  `updatedAt` on a currently-CANCELED row as a stand-in for "changed to
 *  CANCELED recently" — the billing webhook touches both fields together on
 *  a status transition. Not a precise churn *rate* (that needs a historical
 *  active-customer count this schema doesn't track), so the API reports it
 *  as a plain count, not a percentage. */
const CHURN_WINDOW_DAYS = 30;
const DEFAULT_SIGNUP_DAYS = 30;
const DEFAULT_TRIAL_EXPIRY_DAYS = 7;

const PAYING_STATUSES = ['ACTIVE', 'PAST_DUE'] as const;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/** Midnight at the start of the current UTC day — the boundary for the "…today" counters. */
function startOfUtcToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** A maintenance job is an "open defect" until it reaches its terminal COMPLETE state. */
const OPEN_DEFECT_STATUSES = ['OPEN', 'IN_PROGRESS', 'PARTS_PENDING'] as const;

interface DailySignupRow {
  day: Date;
  count: bigint;
}

/**
 * The FleetHQ executive dashboard's real, aggregate business data
 * (21-Admin-Platform/Overview.md) — organisation/user/fleet counts,
 * subscription breakdown, MRR/ARR computed from live Stripe price data,
 * trials, and a churn proxy. Deliberately does NOT report infrastructure
 * metrics (queue depth, cache hit rate, etc.) that don't exist in this
 * codebase's architecture — that would be fabricated data with a real
 * number attached, worse than not showing the widget at all. System/infra
 * health (real: DB connectivity, deploy info) is Phase 5 scope, and reads
 * only what's actually there.
 */
@Injectable()
export class AdminAnalyticsService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}

  async overview() {
    const now = new Date();
    const today = startOfUtcToday();

    const [
      activeOrgs,
      suspendedOrgs,
      archivedOrgs,
      totalOrgs,
      cancelledOrgs,
      newOrgsToday,
      activeTrialOrgs,
      totalUsers,
      newUsers30d,
      newUsersToday,
      totalAssets,
      totalOperators,
      inspectionsChecklist,
      inspectionsForm,
      inspectionsChecklistToday,
      inspectionsFormToday,
      openDefects,
      defectsToday,
      subscriptionCounts,
      canceledRecently,
      revenue,
    ] = await Promise.all([
      this.adminPrisma.company.count({ where: { archivedAt: null, suspendedAt: null } }),
      this.adminPrisma.company.count({ where: { archivedAt: null, suspendedAt: { not: null } } }),
      this.adminPrisma.company.count({ where: { archivedAt: { not: null } } }),
      this.adminPrisma.company.count(),
      this.adminPrisma.company.count({ where: { archivedAt: null, subscriptionStatus: 'CANCELED' } }),
      this.adminPrisma.company.count({ where: { createdAt: { gte: today } } }),
      this.adminPrisma.company.count({ where: { archivedAt: null, trialEndsAt: { gt: now } } }),
      this.adminPrisma.user.count({ where: { archivedAt: null } }),
      this.adminPrisma.user.count({ where: { archivedAt: null, createdAt: { gte: daysAgo(30) } } }),
      this.adminPrisma.user.count({ where: { archivedAt: null, createdAt: { gte: today } } }),
      this.adminPrisma.asset.count(),
      this.adminPrisma.operator.count(),
      this.adminPrisma.checklistSubmission.count(),
      this.adminPrisma.formSubmission.count(),
      this.adminPrisma.checklistSubmission.count({ where: { submittedAt: { gte: today } } }),
      this.adminPrisma.formSubmission.count({ where: { submittedAt: { gte: today } } }),
      this.adminPrisma.maintenanceJob.count({ where: { status: { in: [...OPEN_DEFECT_STATUSES] } } }),
      this.adminPrisma.maintenanceJob.count({ where: { createdAt: { gte: today } } }),
      this.adminPrisma.company.groupBy({ by: ['subscriptionStatus'], where: { archivedAt: null }, _count: true }),
      this.adminPrisma.company.count({
        where: { archivedAt: null, subscriptionStatus: 'CANCELED', updatedAt: { gte: daysAgo(CHURN_WINDOW_DAYS) } },
      }),
      this.computeRevenue(),
    ]);

    return {
      organisations: { active: activeOrgs, suspended: suspendedOrgs, archived: archivedOrgs, cancelled: cancelledOrgs, total: totalOrgs, newToday: newOrgsToday },
      trials: { active: activeTrialOrgs },
      users: { total: totalUsers, newLast30Days: newUsers30d, newToday: newUsersToday },
      fleet: { assets: totalAssets, operators: totalOperators },
      // Inspections = checklist + form submissions across every tenant; defects = maintenance jobs
      // not yet COMPLETE. "…today" is measured from midnight UTC (see startOfUtcToday).
      operations: {
        inspections: inspectionsChecklist + inspectionsForm,
        inspectionsToday: inspectionsChecklistToday + inspectionsFormToday,
        openDefects,
        defectsReportedToday: defectsToday,
      },
      subscriptions: Object.fromEntries(subscriptionCounts.map((c) => [c.subscriptionStatus, c._count])),
      churn: { canceledLast30Days: canceledRecently, windowDays: CHURN_WINDOW_DAYS },
      revenue,
    };
  }

  /**
   * MRR/ARR from the small, fixed set of configured tier price ids
   * (PAID_TIERS) — at most 3 Stripe API calls total, not one per subscribed
   * company. `revenue.byTier` breaks it down so the number is auditable, not
   * a black box.
   */
  private async computeRevenue() {
    if (!this.billing.isConfigured()) {
      return { billingConfigured: false as const, mrr: null, arr: null, currency: null, byTier: [] };
    }

    const configuredPriceIds = Object.keys(PAID_TIERS)
      .map((configVar) => this.config.get<string>(configVar))
      .filter((id): id is string => !!id);

    if (configuredPriceIds.length === 0) {
      return { billingConfigured: true as const, mrr: 0, arr: 0, currency: null, byTier: [] };
    }

    const [amounts, counts] = await Promise.all([
      this.billing.getPriceUnitAmounts(configuredPriceIds),
      this.adminPrisma.company.groupBy({
        by: ['planPriceId'],
        where: { archivedAt: null, planPriceId: { in: configuredPriceIds }, subscriptionStatus: { in: [...PAYING_STATUSES] } },
        _count: true,
      }),
    ]);

    let mrrCents = 0;
    let currency: string | null = null;
    const byTier = Object.entries(PAID_TIERS)
      .map(([configVar, tier]) => {
        const priceId = this.config.get<string>(configVar);
        if (!priceId) return null;
        const amount = amounts[priceId];
        const subscriberCount = counts.find((c) => c.planPriceId === priceId)?._count ?? 0;
        const monthlyCents = amount ? (amount.interval === 'year' ? amount.unitAmount / 12 : amount.unitAmount) : null;
        if (monthlyCents != null) {
          mrrCents += monthlyCents * subscriberCount;
          currency ??= amount!.currency;
        }
        return { tier: tier.key, name: tier.name, priceId, subscriberCount, monthlyUnitAmountCents: monthlyCents };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    return {
      billingConfigured: true as const,
      mrr: Math.round(mrrCents) / 100,
      arr: Math.round(mrrCents * 12) / 100,
      currency,
      byTier,
    };
  }

  /** Daily company-creation counts over the trailing window — "daily signups". */
  async dailySignups(days: number = DEFAULT_SIGNUP_DAYS) {
    const rows = await this.adminPrisma.$queryRaw<DailySignupRow[]>`
      SELECT date_trunc('day', created_at) AS day, count(*)::bigint AS count
      FROM companies
      WHERE created_at >= now() - make_interval(days => ${days}::int)
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ date: r.day.toISOString().slice(0, 10), count: Number(r.count) }));
  }

  /** Trials ending within the window — an actionable follow-up list, not just a count. */
  async trialsExpiring(days: number = DEFAULT_TRIAL_EXPIRY_DAYS) {
    const now = new Date();
    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const companies = await this.adminPrisma.company.findMany({
      where: { archivedAt: null, trialEndsAt: { gte: now, lte: until } },
      orderBy: { trialEndsAt: 'asc' },
      select: { id: true, name: true, trialEndsAt: true, suspendedAt: true, _count: { select: { memberships: true } } },
    });
    return companies.map((c) => ({
      id: c.id,
      name: c.name,
      trialEndsAt: c.trialEndsAt,
      suspended: !!c.suspendedAt,
      userCount: c._count.memberships,
    }));
  }
}
