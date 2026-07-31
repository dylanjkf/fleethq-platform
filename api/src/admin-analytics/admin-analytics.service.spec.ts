import { AdminAnalyticsService } from './admin-analytics.service';

/**
 * Focused unit coverage for the MRR/ARR arithmetic — the part of this
 * service most at risk of a subtle bug (a wrong monthly/yearly
 * normalization silently produces a plausible-looking but incorrect
 * dollar figure). The e2e suite (test/admin-analytics.e2e-spec.ts) covers
 * the "billing not configured" path against the real HTTP API and a live
 * database; it can't exercise a configured-Stripe path since that would
 * require real network access to Stripe, unavailable in CI.
 */
describe('AdminAnalyticsService.computeRevenue (private, exercised directly)', () => {
  function build(config: Record<string, string | undefined>, priceAmounts: Record<string, { unitAmount: number; interval: string; currency: string } | null>, groupByResult: { planPriceId: string | null; _count: number }[]) {
    const adminPrisma = { company: { groupBy: jest.fn().mockResolvedValue(groupByResult) } };
    const billing = {
      isConfigured: jest.fn().mockReturnValue(true),
      getPriceUnitAmounts: jest.fn().mockResolvedValue(priceAmounts),
    };
    const configService = { get: jest.fn((key: string) => config[key]) };
    const service = new AdminAnalyticsService(adminPrisma as never, billing as never, configService as never);
    return { service, adminPrisma, billing };
  }

  it('sums monthly-normalized MRR across tiers, converting annual prices to a monthly figure', async () => {
    const { service } = build(
      { STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_ENTERPRISE: undefined },
      {
        price_starter: { unitAmount: 5000, interval: 'month', currency: 'aud' }, // $50/mo
        price_pro: { unitAmount: 120000, interval: 'year', currency: 'aud' }, // $1200/yr = $100/mo
      },
      [
        { planPriceId: 'price_starter', _count: 3 }, // 3 * $50 = $150
        { planPriceId: 'price_pro', _count: 2 }, // 2 * $100 = $200
      ],
    );

    const revenue = await (service as unknown as { computeRevenue(): Promise<Record<string, unknown>> }).computeRevenue();

    expect(revenue.billingConfigured).toBe(true);
    expect(revenue.mrr).toBe(350);
    expect(revenue.arr).toBe(4200);
    expect(revenue.currency).toBe('aud');
    expect(revenue.byTier).toEqual([
      { tier: 'starter', name: 'Starter', priceId: 'price_starter', subscriberCount: 3, monthlyUnitAmountCents: 5000 },
      { tier: 'pro', name: 'Pro', priceId: 'price_pro', subscriberCount: 2, monthlyUnitAmountCents: 10000 },
    ]);
  });

  it('reports billingConfigured: false without touching Stripe when billing is unconfigured', async () => {
    const adminPrisma = { company: { groupBy: jest.fn() } };
    const billing = { isConfigured: jest.fn().mockReturnValue(false), getPriceUnitAmounts: jest.fn() };
    const configService = { get: jest.fn() };
    const service = new AdminAnalyticsService(adminPrisma as never, billing as never, configService as never);

    const revenue = await (service as unknown as { computeRevenue(): Promise<Record<string, unknown>> }).computeRevenue();

    expect(revenue).toEqual({ billingConfigured: false, mrr: null, arr: null, currency: null, byTier: [] });
    expect(billing.getPriceUnitAmounts).not.toHaveBeenCalled();
    expect(adminPrisma.company.groupBy).not.toHaveBeenCalled();
  });

  it('excludes a tier whose price lookup failed from MRR, but still lists it with a null amount', async () => {
    const { service } = build(
      { STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_PRO: undefined, STRIPE_PRICE_ENTERPRISE: undefined },
      { price_starter: null },
      [{ planPriceId: 'price_starter', _count: 5 }],
    );

    const revenue = await (service as unknown as { computeRevenue(): Promise<Record<string, unknown>> }).computeRevenue();

    expect(revenue.mrr).toBe(0);
    expect(revenue.byTier).toEqual([
      { tier: 'starter', name: 'Starter', priceId: 'price_starter', subscriberCount: 5, monthlyUnitAmountCents: null },
    ]);
  });
});
