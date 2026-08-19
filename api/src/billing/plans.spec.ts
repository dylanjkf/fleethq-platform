import { SubscriptionStatus } from '@prisma/client';
import { FREE_TIER, isSubscriptionActive, flatMonthlyTier, resolvePlanTier } from './plans';

describe('resolvePlanTier', () => {
  const priceIds = { STRIPE_PRICE_STARTER: 'price_s', STRIPE_PRICE_PRO: 'price_p', STRIPE_PRICE_ENTERPRISE: undefined };

  it('maps an active subscription to its configured tier', () => {
    expect(resolvePlanTier(SubscriptionStatus.ACTIVE, 'price_s', priceIds).key).toBe('starter');
    expect(resolvePlanTier(SubscriptionStatus.ACTIVE, 'price_p', priceIds).key).toBe('pro');
  });

  it('keeps entitlements during the past-due grace window', () => {
    expect(resolvePlanTier(SubscriptionStatus.PAST_DUE, 'price_p', priceIds).key).toBe('pro');
  });

  it('falls back to Free for no subscription, cancelled, or an unmatched price', () => {
    expect(resolvePlanTier(SubscriptionStatus.NONE, null, priceIds)).toBe(FREE_TIER);
    expect(resolvePlanTier(SubscriptionStatus.CANCELED, 'price_s', priceIds)).toBe(FREE_TIER);
    expect(resolvePlanTier(SubscriptionStatus.ACTIVE, 'price_unknown', priceIds)).toBe(FREE_TIER);
    // An unconfigured tier (no price id) never matches.
    expect(resolvePlanTier(SubscriptionStatus.ACTIVE, 'price_e', priceIds)).toBe(FREE_TIER);
  });
});

describe('isSubscriptionActive', () => {
  it('is true for ACTIVE, TRIALING and the PAST_DUE grace window', () => {
    expect(isSubscriptionActive(SubscriptionStatus.ACTIVE)).toBe(true);
    expect(isSubscriptionActive(SubscriptionStatus.TRIALING)).toBe(true);
    expect(isSubscriptionActive(SubscriptionStatus.PAST_DUE)).toBe(true);
  });

  it('is false once cancelled or never subscribed', () => {
    expect(isSubscriptionActive(SubscriptionStatus.CANCELED)).toBe(false);
    expect(isSubscriptionActive(SubscriptionStatus.NONE)).toBe(false);
  });
});

describe('flatMonthlyTier', () => {
  it('is unlimited on assets and operators (flat pricing does not cap by fleet size), every feature on', () => {
    const tier = flatMonthlyTier();
    expect(tier.key).toBe('flat');
    // Asset count is purely operational now — no billing-driven cap.
    expect(tier.limits.maxAssets).toBeNull();
    expect(tier.limits.maxOperators).toBeNull();
    expect(tier.features).toEqual(expect.arrayContaining(['core', 'forms', 'intelligence', 'warehouse']));
  });
});
