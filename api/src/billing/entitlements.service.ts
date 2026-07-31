import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureKey, PlanTier, UNLIMITED_TIER, isTrialActive, resolvePlanTier } from './plans';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

  private toEntitlements(plan: PlanTier, trialEndsAt: Date | null, usage: { operators: number; assets: number }): Entitlements {
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
    };
  }

  async getForCompany(companyId: string): Promise<Entitlements> {
    return this.prisma.withTenant(companyId, async (tx) => this.resolve(tx, companyId));
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
      select: { subscriptionStatus: true, planPriceId: true, trialEndsAt: true },
    });
    const plan = resolvePlanTier(company.subscriptionStatus, company.planPriceId, this.priceIds(), company.trialEndsAt);
    const usage = await this.getUsage(tx);
    return this.toEntitlements(plan, company.trialEndsAt, usage);
  }

  /**
   * Blocks creating another operator/asset past the plan limit (402). No-op
   * when enforcement is off or the plan's limit is unlimited, so it's safe to
   * call unconditionally from the create paths. Reuses `resolve()`'s own live
   * usage count rather than querying twice.
   */
  async assertWithinLimit(tx: Prisma.TransactionClient, companyId: string, resource: 'operators' | 'assets'): Promise<void> {
    const entitlements = await this.resolve(tx, companyId);
    const limit = resource === 'operators' ? entitlements.limits.maxOperators : entitlements.limits.maxAssets;
    if (limit == null) return;
    const current = entitlements.usage[resource];
    if (current >= limit) {
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
