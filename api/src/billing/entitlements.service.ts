import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { FeatureKey, PlanTier, UNLIMITED_TIER, isSubscriptionActive, isTrialActive, flatMonthlyTier, resolvePlanTier } from './plans';

/**
 * Pure predicate for "is this company past due AND past its non-payment grace
 * window?". Extracted from `EntitlementsService.computeBillingReadOnly` so the
 * grace gating — active during the window, restricted only once it elapses — can
 * be unit-tested directly against fixed clocks (see billing-read-only.spec) without
 * standing up enforcement config or a database. It does
 * NOT check enforcement or subscription presence; the caller layers those on.
 */
export function isPastDueGraceElapsed(
  company: { subscriptionStatus: SubscriptionStatus; paymentFailureCount: number; gracePeriodEndsAt: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    company.subscriptionStatus === SubscriptionStatus.PAST_DUE &&
    company.paymentFailureCount > 0 &&
    company.gracePeriodEndsAt != null &&
    now.getTime() > company.gracePeriodEndsAt.getTime()
  );
}

export interface Entitlements {
  planKey: string;
  planName: string;
  enforced: boolean;
  features: FeatureKey[];
  limits: { maxOperators: number | null; maxAssets: number | null };
  /**
   * Auth/Billing Platform Phase 9 (usage & feature limit depth): live counts,
   * always reported regardless of `enforced` — a company can see its own
   * usage even before enforcement is switched on. This is what lets the
   * client show "8 of 10 assets" (or warn as a limit approaches) instead of
   * the only signal being a failed create request's 402.
   */
  usage: { operators: number; assets: number };
  /** Native free-trial state, for the countdown/conversion UI. */
  trialEndsAt: string | null;
  trialActive: boolean;
  trialDaysLeft: number | null;
  /**
   * Payment-failure read-only state: true when enforcement is on and the
   * company's paid subscription has exhausted its dunning retries (past due with
   * no next attempt scheduled). The client uses this to show a prominent
   * "billing action required — your fleet is read-only" banner and disable write
   * actions; the server-side write block is applied separately at the guard
   * layer. Never true while enforcement is off, so dev/CI/pilot are unaffected.
   */
  billingReadOnly: boolean;
}

/**
 * Resolves and enforces what a company's subscription actually entitles it to
 * (17-Roadmap/Launch_Readiness_Plan.md A3 — "nothing enforces plans" was the
 * gap). Enforcement is gated behind `BILLING_ENFORCED=true`: off (the default,
 * so dev/CI/pilot are untouched) every company gets the unlimited tier; on,
 * limits and feature flags come from the company's real plan. The *nominal*
 * plan is always reported for display either way.
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemPrisma: SystemPrismaService,
  ) {}

  private isEnforced(): boolean {
    return this.config.get<string>('BILLING_ENFORCED') === 'true';
  }

  private priceIds(): Record<string, string | undefined> {
    return {
      STRIPE_PRICE_STARTER: this.config.get<string>('STRIPE_PRICE_STARTER'),
      STRIPE_PRICE_PRO: this.config.get<string>('STRIPE_PRICE_PRO'),
      STRIPE_PRICE_ENTERPRISE: this.config.get<string>('STRIPE_PRICE_ENTERPRISE'),
    };
  }

  /**
   * The Stripe Price id for the flat monthly plan ($29 AUD/month), if configured.
   * Reads `STRIPE_PRICE_MONTHLY`.
   */
  private flatPriceId(): string | undefined {
    return this.config.get<string>('STRIPE_PRICE_MONTHLY');
  }

  /**
   * Payment-failure read-only predicate: enforcement on, the company actually
   * has a Stripe subscription, it's past due after at least one failure, AND its
   * 7-calendar-day grace window has elapsed. During the grace window (now on or
   * before `gracePeriodEndsAt`) the account stays fully writable — losing access
   * the instant a card fails would punish a transient payment hiccup. Voluntary
   * states (a never-subscribed Free company, an active trial) are never read-only.
   * A past-due company with no grace window set (grace null) is not restricted —
   * the restriction only ever follows an explicit, elapsed grace deadline.
   */
  private computeBillingReadOnly(
    company: {
      subscriptionStatus: SubscriptionStatus;
      stripeSubscriptionId: string | null;
      paymentFailureCount: number;
      gracePeriodEndsAt: Date | null;
    },
    now: Date = new Date(),
  ): boolean {
    if (!this.isEnforced()) return false;
    if (!company.stripeSubscriptionId) return false;
    return isPastDueGraceElapsed(company, now);
  }

  private toEntitlements(
    plan: PlanTier,
    trialEndsAt: Date | null,
    usage: { operators: number; assets: number },
    context: { billingReadOnly: boolean },
  ): Entitlements {
    const enforced = this.isEnforced();
    const effective = enforced ? plan : UNLIMITED_TIER;
    const trialActive = isTrialActive(trialEndsAt);
    const trialDaysLeft = trialActive && trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    return {
      planKey: plan.key,
      planName: plan.name,
      enforced,
      features: effective.features,
      limits: effective.limits,
      usage,
      trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
      trialActive,
      trialDaysLeft,
      billingReadOnly: context.billingReadOnly,
    };
  }

  async getForCompany(companyId: string): Promise<Entitlements> {
    return this.prisma.withTenant(companyId, async (tx) => this.resolve(tx, companyId));
  }

  /**
   * Lean payment-failure read-only check for the write guard — one cheap query,
   * no usage counts or plan resolution. Early-returns false (no query at all)
   * when enforcement is off, so dev/CI/pilot pay nothing per request.
   */
  async isBillingReadOnly(companyId: string): Promise<boolean> {
    if (!this.isEnforced()) return false;
    return this.prisma.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: companyId },
        select: {
          subscriptionStatus: true,
          stripeSubscriptionId: true,
          paymentFailureCount: true,
          gracePeriodEndsAt: true,
        },
      });
      return this.computeBillingReadOnly(company);
    });
  }

  private async getUsage(tx: Prisma.TransactionClient): Promise<{ operators: number; assets: number }> {
    const [operators, assets] = await Promise.all([
      tx.operator.count({ where: { archivedAt: null } }),
      tx.asset.count({ where: { archivedAt: null } }),
    ]);
    return { operators, assets };
  }

  private async resolve(tx: Prisma.TransactionClient, companyId: string): Promise<Entitlements> {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: companyId },
      select: {
        subscriptionStatus: true,
        planPriceId: true,
        trialEndsAt: true,
        stripeSubscriptionId: true,
        nextPaymentAttemptAt: true,
        paymentFailureCount: true,
        gracePeriodEndsAt: true,
      },
    });
    const plan = this.resolvePlan(company);
    const usage = await this.getUsage(tx);
    return this.toEntitlements(plan, company.trialEndsAt, usage, {
      billingReadOnly: this.computeBillingReadOnly(company),
    });
  }

  /**
   * Resolves the plan tier. An active subscription on the flat monthly price
   * yields the flat plan (every feature on, no asset/operator cap — asset count
   * is operational, not billed). Any other state falls through to the legacy
   * tier resolution (trial / Free fallback still apply), so mixed/legacy tenants
   * keep working.
   */
  private resolvePlan(company: {
    subscriptionStatus: SubscriptionStatus;
    planPriceId: string | null;
    trialEndsAt: Date | null;
  }): PlanTier {
    const flatPriceId = this.flatPriceId();
    if (
      flatPriceId &&
      company.planPriceId === flatPriceId &&
      isSubscriptionActive(company.subscriptionStatus)
    ) {
      return flatMonthlyTier();
    }
    return resolvePlanTier(company.subscriptionStatus, company.planPriceId, this.priceIds(), company.trialEndsAt);
  }

  /**
   * Blocks creating another operator/asset past the plan limit (402). No-op
   * when enforcement is off or the plan's limit is unlimited, so it's safe to
   * call unconditionally from the create paths.
   */
  async assertWithinLimit(tx: Prisma.TransactionClient, companyId: string, resource: 'operators' | 'assets'): Promise<void> {
    const entitlements = await this.resolve(tx, companyId);
    const limit = resource === 'operators' ? entitlements.limits.maxOperators : entitlements.limits.maxAssets;
    if (limit == null) return;

    // Close the check-then-insert race: without a lock, N concurrent creates can
    // each read `current < limit` before any commits and all insert, overshooting
    // a paid seat/asset cap. A transaction-scoped advisory lock keyed on
    // (company, resource) serialises concurrent limit checks for the same tenant;
    // it's held until this tx (which also performs the insert) commits, so the
    // count and the insert are effectively atomic. Cross-tenant creates never
    // contend (distinct keys); the lock is independent of RLS. The count is
    // re-read under the lock — `entitlements.usage` was sampled before it was held.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId}), hashtext(${resource}))`;

    const current = resource === 'operators'
      ? await tx.operator.count({ where: { archivedAt: null } })
      : await tx.asset.count({ where: { archivedAt: null } });
    if (current >= limit) {
      // Record the blocked attempt on a SEPARATE connection before throwing:
      // this HttpException rolls back `tx` (the create transaction), so an audit
      // write on `tx` would vanish with it. SystemPrismaService (fleetos_auth,
      // autocommit) persists it regardless. Best-effort — a failed audit write
      // must never turn a clean 402 into a 500. This is the signal the admin
      // console surfaces as "company repeatedly hitting its cap → upsell".
      try {
        await this.systemPrisma.billingAuditLog.create({
          data: {
            companyId,
            eventType: 'CAP_BLOCKED',
            detail: {
              resource,
              attempted: current + 1,
              limit,
              planKey: entitlements.planKey,
            },
          },
        });
      } catch (err) {
        this.logger.warn(`Could not record CAP_BLOCKED audit for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      throw new HttpException(
        {
          code: 'PLAN_LIMIT_REACHED',
          message: `Your ${entitlements.planName} plan is limited to ${limit} ${resource}. Upgrade to add more.`,
          resource,
          limit,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}
