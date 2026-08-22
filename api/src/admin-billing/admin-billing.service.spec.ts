import { AdminBillingService } from './admin-billing.service';

/**
 * Positive-path unit coverage for every Stripe mutation this service makes.
 * test/admin-billing.e2e-spec.ts only exercises the NO_STRIPE_CUSTOMER/
 * NO_STRIPE_SUBSCRIPTION refusal paths against the real HTTP API, since a
 * completed refund/coupon/invoice/credit-note/retry/cancel/reinstate needs a
 * live Stripe test account this offline suite doesn't have — the same
 * documented constraint test/billing.e2e-spec.ts already carries. Here, a
 * mocked Stripe client lets us assert this service calls the right Stripe
 * method with the right arguments and writes the right audit event, without
 * needing real network access.
 */
describe('AdminBillingService (Stripe mocked)', () => {
  const COMPANY = { id: 'company-1', name: 'Test Co', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', subscriptionStatus: 'ACTIVE', planPriceId: 'price_pro', trialEndsAt: null };
  const CONTEXT = { adminUserId: 'admin-1', ip: '127.0.0.1', userAgent: 'jest' };

  function build(company = COMPANY) {
    const adminPrisma = {
      company: { findUnique: jest.fn().mockResolvedValue(company), update: jest.fn().mockResolvedValue(company) },
      // Staff cancel/release now also write the company's billing_audit_logs ledger.
      billingAuditLog: { create: jest.fn().mockResolvedValue({ id: 'bal_1' }) },
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const stripe = {
      invoices: {
        retrieve: jest.fn().mockResolvedValue({ id: 'in_1', customer: company.stripeCustomerId, payments: { data: [{ status: 'paid', is_default: true, payment: { payment_intent: 'pi_1' } }] } }),
        list: jest.fn(),
        pay: jest.fn().mockResolvedValue({ id: 'in_1', status: 'paid' }),
        create: jest.fn().mockResolvedValue({ id: 'in_draft' }),
        finalizeInvoice: jest.fn().mockResolvedValue({ id: 'in_2', status: 'open', hosted_invoice_url: 'https://stripe.example/in_2' }),
      },
      invoiceItems: { create: jest.fn().mockResolvedValue({ id: 'ii_1' }) },
      refunds: { create: jest.fn().mockResolvedValue({ id: 're_1', amount: 1000, status: 'succeeded' }) },
      subscriptions: {
        update: jest.fn().mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: false, discounts: ['di_1'] }),
        cancel: jest.fn().mockResolvedValue({ id: 'sub_1', status: 'canceled', cancel_at_period_end: false }),
        retrieve: jest.fn().mockResolvedValue({ id: 'sub_1', status: 'active', cancel_at_period_end: true, discounts: [] }),
      },
      creditNotes: { create: jest.fn().mockResolvedValue({ id: 'cn_1', amount: 500, status: 'issued' }) },
    };
    const billing = {
      isConfigured: jest.fn().mockReturnValue(true),
      isTaxEnabled: jest.fn().mockReturnValue(false),
      getStripeClient: jest.fn().mockReturnValue(stripe),
    };
    const service = new AdminBillingService(adminPrisma as never, audit as never, billing as never);
    return { service, adminPrisma, audit, stripe, billing };
  }

  /** Every mutating Stripe call must carry a deterministic idempotency key so a double-submit can't issue two real financial events. */
  const withIdempotencyKey = expect.objectContaining({ idempotencyKey: expect.stringContaining('admin-billing:admin-1:') });

  it('refunds a payment intent and audit-logs it', async () => {
    const { service, stripe, audit } = build();
    const result = await service.refund('company-1', { invoiceId: 'in_1', amountCents: 1000, reason: 'requested_by_customer' }, CONTEXT);

    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: 'pi_1', charge: undefined, amount: 1000, reason: 'requested_by_customer' },
      withIdempotencyKey,
    );
    expect(result).toEqual({ refundId: 're_1', amountCents: 1000, status: 'succeeded' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.refund_issued', organisationId: 'company-1' }));
  });

  it('rejects a refund for an invoice belonging to a different Stripe customer', async () => {
    const { service, stripe } = build();
    stripe.invoices.retrieve.mockResolvedValueOnce({ id: 'in_1', customer: 'cus_other', payments: { data: [] } });

    await expect(service.refund('company-1', { invoiceId: 'in_1' }, CONTEXT)).rejects.toMatchObject({ status: 404 });
  });

  it('applies a coupon to the subscription and audit-logs it', async () => {
    const { service, stripe, audit } = build();
    const result = await service.applyCoupon('company-1', { couponId: 'coupon_1' }, CONTEXT);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { discounts: [{ coupon: 'coupon_1' }] }, withIdempotencyKey);
    expect(result).toEqual({ subscriptionId: 'sub_1', discounts: ['di_1'] });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.coupon_applied', beforeValue: expect.objectContaining({ discounts: expect.anything() }) }),
    );
  });

  it('creates a manual invoice item, finalizes it, and audit-logs it', async () => {
    const { service, stripe, audit } = build();
    const result = await service.createManualInvoice('company-1', { description: 'Onboarding fee', amountCents: 20000 }, CONTEXT);

    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      { customer: 'cus_1', amount: 20000, currency: 'aud', description: 'Onboarding fee' },
      withIdempotencyKey,
    );
    // Tax disabled by default in this build() → no automatic_tax on the invoice.
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', collection_method: 'send_invoice', days_until_due: 7 }),
      withIdempotencyKey,
    );
    expect(stripe.invoices.create.mock.calls[0][0]).not.toHaveProperty('automatic_tax');
    expect(stripe.invoices.finalizeInvoice).toHaveBeenCalledWith('in_draft', undefined, withIdempotencyKey);
    expect(result).toEqual({ invoiceId: 'in_2', status: 'open', hostedInvoiceUrl: 'https://stripe.example/in_2' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.manual_invoice_created' }));
  });

  it('adds automatic_tax to a manual invoice when Stripe Tax is enabled (GST parity with checkout)', async () => {
    const { service, stripe, billing } = build();
    billing.isTaxEnabled.mockReturnValue(true);
    await service.createManualInvoice('company-1', { description: 'Onboarding fee', amountCents: 20000 }, CONTEXT);

    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ automatic_tax: { enabled: true } }),
      withIdempotencyKey,
    );
  });

  it('issues a credit note and audit-logs it', async () => {
    const { service, stripe, audit } = build();
    const result = await service.issueCreditNote('company-1', { invoiceId: 'in_1', amountCents: 500, reason: 'order_change' }, CONTEXT);

    expect(stripe.creditNotes.create).toHaveBeenCalledWith({ invoice: 'in_1', amount: 500, reason: 'order_change' }, withIdempotencyKey);
    expect(result).toEqual({ creditNoteId: 'cn_1', amountCents: 500, status: 'issued' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.credit_note_issued' }));
  });

  it('retries a payment and audit-logs it', async () => {
    const { service, stripe, audit } = build();
    const result = await service.retryPayment('company-1', { invoiceId: 'in_1' }, CONTEXT);

    expect(stripe.invoices.pay).toHaveBeenCalledWith('in_1', undefined, withIdempotencyKey);
    expect(result).toEqual({ invoiceId: 'in_1', status: 'paid' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.payment_retried' }));
  });

  it('cancels a subscription immediately when atPeriodEnd is not set', async () => {
    const { service, stripe, audit } = build();
    const result = await service.cancelSubscription('company-1', {}, CONTEXT);

    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith('sub_1', undefined, withIdempotencyKey);
    expect(result).toEqual({ subscriptionId: 'sub_1', status: 'canceled', cancelAtPeriodEnd: false });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'billing.subscription_canceled' }));
  });

  it('schedules a cancellation at period end when atPeriodEnd is true', async () => {
    const { service, stripe } = build();
    await service.cancelSubscription('company-1', { atPeriodEnd: true }, CONTEXT);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true }, withIdempotencyKey);
  });

  it('reinstates a subscription pending cancellation and audit-logs it', async () => {
    const { service, stripe, audit } = build();
    const result = await service.reinstateSubscription('company-1', CONTEXT);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false }, withIdempotencyKey);
    expect(result).toEqual({ subscriptionId: 'sub_1', status: 'active', cancelAtPeriodEnd: false });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'billing.subscription_reinstated', beforeValue: expect.objectContaining({ cancelAtPeriodEnd: true }) }),
    );
  });

  it('refuses to reinstate a subscription that has already fully canceled', async () => {
    const { service, stripe } = build();
    stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: 'sub_1', status: 'canceled', cancel_at_period_end: false });

    await expect(service.reinstateSubscription('company-1', CONTEXT)).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_ALREADY_CANCELED' },
    });
  });

  it('refuses to reinstate a subscription that was never scheduled to cancel', async () => {
    const { service, stripe } = build();
    stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: 'sub_1', status: 'active', cancel_at_period_end: false });

    await expect(service.reinstateSubscription('company-1', CONTEXT)).rejects.toMatchObject({
      response: { code: 'SUBSCRIPTION_NOT_PENDING_CANCELLATION' },
    });
  });
});
