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
    const service = new BillingService(prisma as never, systemPrisma as never, config as never, notifications as never, billingMail as never);

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
    const service = new BillingService(prisma as never, systemPrisma as never, config as never, {} as never, {} as never);
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
