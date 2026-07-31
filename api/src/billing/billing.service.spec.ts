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
    const config = {
      get: (key: string) => (key === 'STRIPE_TAX_ENABLED' ? String(taxEnabled) : key === 'STRIPE_SECRET_KEY' ? 'sk_test_fake' : undefined),
    };
    const notifications = {};
    const billingMail = {};
    const service = new BillingService(prisma as never, config as never, notifications as never, billingMail as never);

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
