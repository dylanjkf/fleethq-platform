import { SubscriptionStatus } from '@prisma/client';
import { FREE_TIER, resolvePlanTier } from './plans';

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
