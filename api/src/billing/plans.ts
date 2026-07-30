import { SubscriptionStatus } from '@prisma/client';

/**
 * Capability flags a plan can include. Surfaced to the client to gate UI **and**
 * enforced server-side by FeatureGuard (`@RequireFeature`) so a paid add-on
 * can't be reached by calling the API directly.
 *
 * `warehouse` is the paid Warehouse add-on and is a genuine paywall as of the
 * founder's 2026-07-24 direction ("warehouse should be behind a paywall").
 * This **reverses** the earlier rule that the flag drive UI presentation only
 * and never gate the API — that rule made the add-on unenforceable, since the
 * SPA hiding a module is not a paywall. Reversed deliberately, not by accident.
 *
 * Two properties are preserved from the original intent:
 *  - **No data is destroyed or held hostage.** A lapsed plan makes warehouse
 *    data unreachable, never deleted; upgrading restores access intact.
 *  - **Nothing bites before billing is live.** The gate is inert while
 *    `BILLING_ENFORCED` is not `true`, so dev/CI/pilot are unaffected.
 */
export type FeatureKey = 'core' | 'forms' | 'intelligence' | 'warehouse';

export interface PlanLimits {
  /** null = unlimited. */
  maxOperators: number | null;
  maxAssets: number | null;
}

export interface PlanTier {
  key: string;
  name: string;
  features: FeatureKey[];
  limits: PlanLimits;
}

/** The fallback when a company has no active paid subscription. */
export const FREE_TIER: PlanTier = {
  key: 'free',
  name: 'Free',
  features: ['core'],
  limits: { maxOperators: 3, maxAssets: 3 },
};

/** Everything on, no limits — used when enforcement is off (dev/CI/pilot). */
export const UNLIMITED_TIER: PlanTier = {
  key: 'unlimited',
  name: 'Unlimited',
  features: ['core', 'forms', 'intelligence', 'warehouse'],
  limits: { maxOperators: null, maxAssets: null },
};

/**
 * The tier a company is on during its self-serve free trial — a genuine taste
 * of the paid product (every feature on) with generous-but-bounded limits so a
 * small courier can run their whole fleet through the trial without hitting a
 * wall, then convert. Applies while `now < trialEndsAt`.
 */
export const TRIAL_TIER: PlanTier = {
  key: 'trial',
  name: 'Free trial',
  features: ['core', 'forms', 'intelligence', 'warehouse'],
  limits: { maxOperators: 25, maxAssets: 25 },
};

/** Days a self-serve signup gets before the trial lapses to Free. */
export const TRIAL_DAYS = 14;

/** The purchasable tiers, keyed by the config var holding their Stripe price id. */
export const PAID_TIERS: Record<string, PlanTier> = {
  STRIPE_PRICE_STARTER: { key: 'starter', name: 'Starter', features: ['core', 'forms'], limits: { maxOperators: 10, maxAssets: 10 } },
  STRIPE_PRICE_PRO: { key: 'pro', name: 'Pro', features: ['core', 'forms', 'intelligence', 'warehouse'], limits: { maxOperators: 50, maxAssets: 50 } },
  STRIPE_PRICE_ENTERPRISE: { key: 'enterprise', name: 'Enterprise', features: ['core', 'forms', 'intelligence', 'warehouse'], limits: { maxOperators: null, maxAssets: null } },
};

const ACTIVE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  // Still entitled during the dunning grace window — losing access the instant a
  // card fails would punish the customer for a transient payment hiccup.
  SubscriptionStatus.PAST_DUE,
];

/**
 * Resolves the tier a company is on from its subscription state and the
 * configured price→tier map. Pure so it's trivially unit-testable. An active
 * subscription whose price id doesn't match any configured tier (misconfig)
 * falls back to Free rather than silently granting everything.
 */
export function resolvePlanTier(
  status: SubscriptionStatus,
  planPriceId: string | null,
  priceIds: Record<string, string | undefined>,
  trialEndsAt: Date | null = null,
  now: Date = new Date(),
): PlanTier {
  // A real paid subscription always wins over a lingering trial window.
  if (ACTIVE_STATUSES.includes(status) && planPriceId) {
    for (const [configVar, tier] of Object.entries(PAID_TIERS)) {
      if (priceIds[configVar] && priceIds[configVar] === planPriceId) return tier;
    }
  }
  // Otherwise, an unexpired native free trial grants the Trial tier.
  if (trialEndsAt && trialEndsAt.getTime() > now.getTime()) return TRIAL_TIER;
  return FREE_TIER;
}

/** Whether a company is currently inside its native free-trial window. */
export function isTrialActive(trialEndsAt: Date | null, now: Date = new Date()): boolean {
  return !!trialEndsAt && trialEndsAt.getTime() > now.getTime();
}
