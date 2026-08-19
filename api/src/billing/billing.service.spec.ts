import { BillingService } from './billing.service';

/**
 * Auth/Billing Platform Phase 8 (GST / Australian tax invoicing) unit
 * coverage — mirrors admin-billing.service.spec.ts's approach: a mocked
 * Stripe client lets us assert the right params are sent without a real
 * network call, the same documented constraint test/billing.e2e-spec.ts's
 * own comment carries for checkout/portal session creation.
 */
describe('BillingService — GST tax invoicing (Stripe mocked)', () => {
  function build(companyOverrides: { abn?: string | null; stripeCustomerId?: string | null } = {}, taxEnabled = false) {
    const company = { id: 'company-1', name: 'Acme Couriers', abn: null, stripeCustomerId: null, ...companyOverrides };
    const tx = {
      company: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(company),
        update: jest.fn().mockResolvedValue(company),
      },
    };
    const prisma = { withTenant: jest.fn((_companyId: string, fn: (tx: unknown) => unknown) => fn(tx)) };
    const systemPrisma = { stripeWebhookEvent: { create: jest.fn().mockResolvedValue({}) } };
    const config = {
      get: (key: string) =>
        key === 'STRIPE_TAX_ENABLED'
          ? String(taxEnabled)
          : key === 'STRIPE_SECRET_KEY'
            ? 'sk_test_fake'
            : key === 'STRIPE_PRICE_STARTER'
              ? 'price_1' // the price id the tests check out with must be a configured tier
              : undefined,
    };
    const notifications = {};
    const billingMail = {};
    const signup = { provisionFromCompletedCheckout: jest.fn().mockResolvedValue(undefined) };
    const service = new BillingService(prisma as never, systemPrisma as never, config as never, notifications as never, billingMail as never, signup as never);

    const stripe = {
      customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }) },
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.example/cs_1' }) } },
    };
    (service as unknown as { stripeClient: unknown }).stripeClient = stripe;
    return { service, stripe, tx };
  }

  it('attaches the company ABN as a Stripe au_abn tax ID when creating a new customer', async () => {
    const { service, stripe } = build({ abn: '53 004 085 616' });
    await service.createCheckoutSession('company-1', 'price_1', 'https://app/success', 'https://app/cancel');

    expect(stripe.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({ tax_id_data: [{ type: 'au_abn', value: '53004085616' }] }),
      expect.objectContaining({ idempotencyKey: 'customer:company-1' }),
    );
  });

  it('does not send tax_id_data when the company has no ABN on file', async () => {
    const { service, stripe } = build({ abn: null });
    await service.createCheckoutSession('company-1', 'price_1', 'https://app/success', 'https://app/cancel');

    const createArgs = stripe.customers.create.mock.calls[0][0];
    expect(createArgs).not.toHaveProperty('tax_id_data');
  });

  it('never attaches a tax ID for a company that already has a Stripe customer (no create call at all)', async () => {
    const { service, stripe } = build({ abn: '53 004 085 616', stripeCustomerId: 'cus_existing' });
    await service.createCheckoutSession('company-1', 'price_1', 'https://app/success', 'https://app/cancel');
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('adds automatic_tax and tax_id_collection to the Checkout Session only when STRIPE_TAX_ENABLED is true', async () => {
    const disabled = build({}, false);
    await disabled.service.createCheckoutSession('company-1', 'price_1', 'https://app/success', 'https://app/cancel');
    const disabledArgs = disabled.stripe.checkout.sessions.create.mock.calls[0][0];
    expect(disabledArgs).not.toHaveProperty('automatic_tax');
    expect(disabledArgs).not.toHaveProperty('tax_id_collection');

    const enabled = build({}, true);
    await enabled.service.createCheckoutSession('company-1', 'price_1', 'https://app/success', 'https://app/cancel');
    const enabledArgs = enabled.stripe.checkout.sessions.create.mock.calls[0][0];
    expect(enabledArgs.automatic_tax).toEqual({ enabled: true });
    expect(enabledArgs.tax_id_collection).toEqual({ enabled: true });
  });
});

describe('BillingService — checkout integrity (audit remediation)', () => {
  function build() {
    const company = { id: 'company-1', name: 'Acme Couriers', abn: null, stripeCustomerId: 'cus_existing' };
    const tx = { company: { findUniqueOrThrow: jest.fn().mockResolvedValue(company), update: jest.fn() } };
    const prisma = { withTenant: jest.fn((_c: string, fn: (tx: unknown) => unknown) => fn(tx)) };
    const systemPrisma = { stripeWebhookEvent: { create: jest.fn().mockResolvedValue({}) } };
    const config = {
      get: (key: string) =>
        key === 'STRIPE_SECRET_KEY' ? 'sk_test_fake' : key === 'STRIPE_PRICE_STARTER' ? 'price_configured' : undefined,
    };
    const service = new BillingService(prisma as never, systemPrisma as never, config as never, {} as never, {} as never, {} as never);
    const stripe = {
      customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }) },
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.example/cs_1' }) } },
    };
    (service as unknown as { stripeClient: unknown }).stripeClient = stripe;
    return { service, stripe };
  }

  it('rejects a priceId that is not a configured plan tier', async () => {
    const { service, stripe } = build();
    await expect(
      service.createCheckoutSession('company-1', 'price_not_configured', 'https://app/success', 'https://app/cancel'),
    ).rejects.toMatchObject({ response: { code: 'UNKNOWN_PRICE_ID' } });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('passes an idempotency key on the checkout session for a configured price', async () => {
    const { service, stripe } = build();
    await service.createCheckoutSession('company-1', 'price_configured', 'https://app/success', 'https://app/cancel');
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: 'price_configured', quantity: 1 }] }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('checkout:company-1:price_configured:') }),
    );
  });
});

describe('BillingService — billing portal allowlist (audit remediation)', () => {
  function build(configOverrides: Record<string, string | undefined> = {}) {
    const company = { stripeCustomerId: 'cus_1' };
    const tx = { company: { findUniqueOrThrow: jest.fn().mockResolvedValue(company) } };
    const prisma = { withTenant: jest.fn((_c: string, fn: (tx: unknown) => unknown) => fn(tx)) };
    const config = {
      get: (key: string): string | undefined => {
        const base: Record<string, string | undefined> = {
          STRIPE_SECRET_KEY: 'sk_test_fake',
          STRIPE_PRICE_STARTER: 'price_1',
          APP_BASE_URL: 'https://app.example',
          ...configOverrides,
        };
        return base[key];
      },
    };
    const service = new BillingService(prisma as never, {} as never, config as never, {} as never, {} as never, {} as never);
    const stripe = {
      prices: { retrieve: jest.fn().mockResolvedValue({ id: 'price_1', product: 'prod_1' }) },
      billingPortal: {
        configurations: {
          list: jest.fn().mockResolvedValue({ data: [] }),
          create: jest.fn().mockResolvedValue({ id: 'bpc_new' }),
        },
        sessions: { create: jest.fn().mockResolvedValue({ url: 'https://portal.stripe.example/ps_1' }) },
      },
    };
    (service as unknown as { stripeClient: unknown }).stripeClient = stripe;
    return { service, stripe };
  }

  it('pins the portal session to a configuration whose plan-switching is restricted to the checkout allowlist', async () => {
    const { service, stripe } = build();
    await service.createPortalSession('company-1', 'https://app.example/return');

    // A configuration is built, restricting subscription_update to the exact sold prices grouped by product.
    expect(stripe.billingPortal.configurations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({
          subscription_update: expect.objectContaining({
            enabled: true,
            products: [{ product: 'prod_1', prices: ['price_1'] }],
          }),
        }),
      }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('portal-config:') }),
    );
    // And the session is created WITH that configuration id (never the Dashboard default).
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', configuration: 'bpc_new' }),
    );
  });

  it('reuses an explicit STRIPE_PORTAL_CONFIGURATION_ID without building a new configuration', async () => {
    const { service, stripe } = build({ STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_explicit' });
    await service.createPortalSession('company-1', 'https://app.example/return');

    expect(stripe.billingPortal.configurations.create).not.toHaveBeenCalled();
    expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ configuration: 'bpc_explicit' }),
    );
  });

  it('disables plan-switching entirely when there is no configured price allowlist', async () => {
    const { service, stripe } = build({ STRIPE_PRICE_STARTER: undefined });
    await service.createPortalSession('company-1', 'https://app.example/return');

    expect(stripe.billingPortal.configurations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({ subscription_update: { enabled: false } }),
      }),
      expect.anything(),
    );
  });
});

describe('BillingService — native trial-ending reminder (audit remediation)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = new Date('2026-08-02T00:00:00.000Z');

  function build(company: { name: string; trialEndsAt: Date | null; subscriptionStatus: string }, existingReminder = false) {
    const tx = {
      company: { findUniqueOrThrow: jest.fn().mockResolvedValue(company) },
      notification: { findFirst: jest.fn().mockResolvedValue(existingReminder ? { id: 'n1' } : null) },
    };
    const prisma = { withTenant: jest.fn((_c: string, fn: (tx: unknown) => unknown) => fn(tx)) };
    const notifications = {
      notifyPermissionInTx: jest.fn().mockResolvedValue(undefined),
      getPermissionHolders: jest.fn().mockResolvedValue([{ id: 'u1', fullName: 'Ada', email: 'ada@example.com' }]),
    };
    const billingMail = { sendTrialEndingReminder: jest.fn().mockResolvedValue(undefined) };
    const service = new BillingService(prisma as never, {} as never, {} as never, notifications as never, billingMail as never, {} as never);
    return { service, tx, notifications, billingMail };
  }

  it('reminds billing:manage holders once when the trial ends within the window and no plan is taken up', async () => {
    const { service, notifications, billingMail } = build({ name: 'Acme', trialEndsAt: new Date(NOW.getTime() + 2 * DAY_MS), subscriptionStatus: 'NONE' });
    const reminded = await service.remindTrialEnding('company-1', NOW);
    expect(reminded).toBe(1);
    expect(notifications.notifyPermissionInTx).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.anything(),
      expect.objectContaining({ type: 'billing.trial_ending' }),
    );
    expect(billingMail.sendTrialEndingReminder).toHaveBeenCalled();
  });

  it('is idempotent — a company already reminded in this window is a no-op', async () => {
    const { service, notifications } = build({ name: 'Acme', trialEndsAt: new Date(NOW.getTime() + 2 * DAY_MS), subscriptionStatus: 'NONE' }, true);
    expect(await service.remindTrialEnding('company-1', NOW)).toBe(0);
    expect(notifications.notifyPermissionInTx).not.toHaveBeenCalled();
  });

  it('does not remind a company that has already taken up a subscription', async () => {
    const { service, notifications } = build({ name: 'Acme', trialEndsAt: new Date(NOW.getTime() + 2 * DAY_MS), subscriptionStatus: 'ACTIVE' });
    expect(await service.remindTrialEnding('company-1', NOW)).toBe(0);
    expect(notifications.notifyPermissionInTx).not.toHaveBeenCalled();
  });

  it('does not remind outside the window (trial ends far in the future)', async () => {
    const { service, notifications } = build({ name: 'Acme', trialEndsAt: new Date(NOW.getTime() + 10 * DAY_MS), subscriptionStatus: 'NONE' });
    expect(await service.remindTrialEnding('company-1', NOW)).toBe(0);
    expect(notifications.notifyPermissionInTx).not.toHaveBeenCalled();
  });

  it('does not remind after the trial has already ended', async () => {
    const { service, notifications } = build({ name: 'Acme', trialEndsAt: new Date(NOW.getTime() - DAY_MS), subscriptionStatus: 'NONE' });
    expect(await service.remindTrialEnding('company-1', NOW)).toBe(0);
    expect(notifications.notifyPermissionInTx).not.toHaveBeenCalled();
  });

  it('does not remind a company with no native trial set', async () => {
    const { service, notifications } = build({ name: 'Acme', trialEndsAt: null, subscriptionStatus: 'NONE' });
    expect(await service.remindTrialEnding('company-1', NOW)).toBe(0);
    expect(notifications.notifyPermissionInTx).not.toHaveBeenCalled();
  });
});

describe('BillingService — chargeback webhook (audit remediation)', () => {
  function build() {
    const tx = { company: { findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Acme Couriers' }) } };
    const prisma = { withTenant: jest.fn((_c: string, fn: (tx: unknown) => unknown) => fn(tx)) };
    const systemPrisma = { stripeWebhookEvent: { create: jest.fn().mockResolvedValue({}) } };
    const config = { get: (key: string) => (key === 'STRIPE_SECRET_KEY' ? 'sk_test_fake' : key === 'STRIPE_WEBHOOK_SECRET' ? 'whsec_fake' : undefined) };
    const notifications = {
      notifyPermissionInTx: jest.fn().mockResolvedValue(undefined),
      getPermissionHolders: jest.fn().mockResolvedValue([{ id: 'u1', fullName: 'Ada', email: 'ada@example.com' }]),
    };
    const billingMail = { sendDisputeCreated: jest.fn().mockResolvedValue(undefined) };
    const signup = { provisionFromCompletedCheckout: jest.fn().mockResolvedValue(undefined) };
    const service = new BillingService(prisma as never, systemPrisma as never, config as never, notifications as never, billingMail as never, signup as never);
    const stripe = {
      webhooks: { constructEvent: jest.fn() },
      charges: { retrieve: jest.fn().mockResolvedValue({ id: 'ch_1', metadata: { fleetosCompanyId: 'company-1' } }) },
    };
    (service as unknown as { stripeClient: unknown }).stripeClient = stripe;
    return { service, stripe, notifications, billingMail };
  }

  it('notifies AND emails billing:manage holders on charge.dispute.created (never silent)', async () => {
    const { service, stripe, notifications, billingMail } = build();
    stripe.webhooks.constructEvent.mockReturnValue({
      id: 'evt_1',
      type: 'charge.dispute.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'dp_1', charge: 'ch_1', amount: 4200, currency: 'aud', evidence_details: { due_by: null } } },
    });

    await service.handleWebhookEvent(Buffer.from('{}'), 'sig');

    expect(notifications.notifyPermissionInTx).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.anything(),
      expect.objectContaining({ type: 'billing.dispute_created' }),
    );
    expect(billingMail.sendDisputeCreated).toHaveBeenCalledWith('ada@example.com', 'Ada', 'Acme Couriers', expect.any(String), null);
  });
});

/**
 * Flat monthly pricing: the checkout always buys quantity 1 of the flat price
 * (the charge never scales with fleet size), an existing subscriber can't open a
 * duplicate subscription (ALREADY_SUBSCRIBED), and syncSubscription no longer
 * derives an asset cap from the Stripe quantity (there is no cap anymore).
 */
describe('BillingService — flat-rate checkout guards & sync', () => {
  const FLAT_PRICE = 'price_flat_monthly';

  function build(company: Record<string, unknown>) {
    const tx = {
      company: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(company),
        update: jest.fn().mockResolvedValue(company),
      },
      asset: { count: jest.fn() },
      billingAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = { withTenant: jest.fn((_c: string, fn: (tx: unknown) => unknown) => fn(tx)) };
    const config = {
      get: (key: string) =>
        key === 'STRIPE_SECRET_KEY'
          ? 'sk_test_fake'
          : key === 'STRIPE_PRICE_MONTHLY'
            ? FLAT_PRICE
            : key === 'STRIPE_PRICE_STARTER'
              ? 'price_1'
              : undefined,
    };
    const service = new BillingService(prisma as never, {} as never, config as never, {} as never, {} as never, {} as never);
    const stripe = {
      customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }) },
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://checkout.example/cs' }) } },
    };
    (service as unknown as { stripeClient: unknown }).stripeClient = stripe;
    return { service, tx, stripe };
  }

  it('createCheckoutSession rejects ALREADY_SUBSCRIBED for a company with a live subscription (no Stripe session created)', async () => {
    const { service, stripe } = build({
      id: 'company-1',
      name: 'Acme',
      abn: null,
      stripeCustomerId: 'cus_x',
      stripeSubscriptionId: 'sub_live',
      subscriptionStatus: 'ACTIVE',
    });

    await expect(
      service.createCheckoutSession('company-1', 'price_1', 'https://app/success', 'https://app/cancel'),
    ).rejects.toMatchObject({ response: { code: 'ALREADY_SUBSCRIBED' } });
    // It bails BEFORE ever starting a Stripe checkout — no duplicate subscription.
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('createCheckoutSession buys the flat price at quantity 1 — the charge does not scale', async () => {
    const { service, stripe } = build({
      id: 'company-1',
      name: 'Acme',
      abn: null,
      stripeCustomerId: 'cus_x',
      stripeSubscriptionId: null,
      subscriptionStatus: 'NONE',
    });

    await service.createCheckoutSession('company-1', FLAT_PRICE, 'https://app/success', 'https://app/cancel');
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ line_items: [{ price: FLAT_PRICE, quantity: 1 }] }),
      expect.anything(),
    );
  });

  it('syncSubscription records the plan price but never writes an asset cap or a CAP_BLOCKED row, no matter how many assets are live', async () => {
    const { service, tx } = build({ lastStripeEventAt: null, subscriptionStartedAt: new Date('2026-01-01') });
    tx.asset.count.mockResolvedValue(50); // 50 live assets — irrelevant under flat pricing

    const subscription = {
      id: 'sub_1',
      status: 'active',
      items: { data: [{ price: { id: FLAT_PRICE }, quantity: 1 }] },
    };
    await (
      service as unknown as { syncSubscription: (c: string, cust: string, sub: unknown, at: Date) => Promise<void> }
    ).syncSubscription('company-1', 'cus_x', subscription, new Date('2026-06-01'));

    const updateArg = tx.company.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(updateArg.data.planPriceId).toBe(FLAT_PRICE);
    // No asset cap is derived from the subscription anymore.
    expect(updateArg.data).not.toHaveProperty('assetQuantity');
    // ...and no CAP_BLOCKED / quantity-floor audit is ever written.
    expect(tx.billingAuditLog.create).not.toHaveBeenCalled();
  });
});
