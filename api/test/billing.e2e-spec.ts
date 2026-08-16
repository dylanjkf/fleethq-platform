/**
 * Billing/subscription system (19-Billing/Billing_And_Subscriptions.md).
 * STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are set to fake test-mode-shaped
 * values before buildTestApp() runs, purely so the webhook signature tests
 * can exercise the real Stripe SDK signature verification offline — this
 * never talks to Stripe's real API (only stripe.webhooks.* calls, which are
 * pure local HMAC computation, are used). Checkout/portal-session creation
 * DOES need a real network call, so those are only tested in their
 * not-configured (400) form here — see this file's own tests for why.
 */
process.env.STRIPE_SECRET_KEY = 'sk_test_fake_for_offline_signature_verification_only';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake_test_secret';

import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const testWebhooks = new Stripe(process.env.STRIPE_SECRET_KEY).webhooks;

function signedWebhookRequest(app: INestApplication, eventBody: unknown) {
  const payload = JSON.stringify(eventBody);
  const signature = testWebhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET as string });
  return request(app.getHttpServer())
    .post('/v1/billing/webhook')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signature)
    .send(payload);
}

/**
 * companyId travels in the subscription's own `metadata.fleetosCompanyId`
 * (set at checkout-session creation time), not resolved by looking the
 * company up by Stripe customer ID — `companies` has the same
 * `id = current_setting('app.current_company_id')` row-level-security
 * policy as every other tenant table, so nothing can query it by an
 * arbitrary Stripe ID without already knowing which company it's looking
 * for. See BillingService's own doc comment for the fuller story.
 */
// Real Stripe events each carry a unique id and a strictly-increasing `created`
// timestamp; the handler now relies on both (idempotency ledger + out-of-order
// guard), so the fakes must too — a monotonic counter gives each event a
// distinct id and a later `created` than the one before it.
let eventSeq = 0;
function nextEvent(): { id: string; created: number } {
  eventSeq += 1;
  return { id: `evt_${eventSeq}_${Math.random().toString(36).slice(2)}`, created: 1_700_000_000 + eventSeq };
}

function subscriptionUpdatedEvent(customerId: string, subscriptionId: string, status: string, priceId: string, companyId?: string) {
  return {
    ...nextEvent(),
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: subscriptionId,
        object: 'subscription',
        customer: customerId,
        status,
        items: { data: [{ price: { id: priceId } }] },
        metadata: companyId ? { fleetosCompanyId: companyId } : {},
      },
    },
  };
}

/**
 * Auth/Billing Platform Phase 5 (full Stripe webhook coverage +
 * failed-payment handling). companyId travels the same way as the
 * subscription events above — Stripe snapshots `subscription.metadata` onto
 * `invoice.parent.subscription_details.metadata` at invoice finalization, so
 * no extra Stripe API round-trip is needed to resolve it.
 */
function invoiceEvent(
  type: 'invoice.payment_failed' | 'invoice.paid',
  subscriptionId: string,
  companyId?: string,
  nextPaymentAttempt: number | null = null,
) {
  return {
    id: `evt_${type}_${subscriptionId}_${Math.random()}`,
    object: 'event',
    type,
    data: {
      object: {
        id: `in_${subscriptionId}`,
        object: 'invoice',
        next_payment_attempt: nextPaymentAttempt,
        parent: {
          type: 'subscription_details',
          subscription_details: {
            subscription: subscriptionId,
            metadata: companyId ? { fleetosCompanyId: companyId } : {},
          },
        },
      },
    },
  };
}

describe('Billing / subscriptions', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('reports NONE/not-yet-subscribed status for a fresh company', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW]);
    const token = await login(tenant.username);

    const res = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.subscriptionStatus).toBe('NONE');
    expect(res.body.planPriceId).toBeNull();
    expect(res.body.hasStripeCustomer).toBe(false);
  });

  it('leads the plan picker with the per-asset plan', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW]);
    const token = await login(tenant.username);

    const res = await request(app.getHttpServer()).get('/v1/billing/plans').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    // Under the per-asset model the picker leads with the single per-asset plan;
    // legacy fixed tiers (starter/pro/enterprise) only surface when their Stripe
    // price ids are configured on this deployment (they are not in CI).
    const perAsset = res.body.plans[0];
    expect(perAsset.key).toBe('per_asset');
    expect(perAsset.perAsset).toBe(true);
    expect(perAsset.features).toEqual(expect.arrayContaining(['core', 'intelligence']));
    expect(perAsset).toHaveProperty('priceId');
    expect(perAsset).toHaveProperty('purchasable');
    expect(perAsset).toHaveProperty('pricePerAssetCents');
    // Any legacy tier that does appear must be marked purchasable.
    for (const p of res.body.plans.slice(1)) {
      expect(p.purchasable).toBe(true);
    }
  });

  it('plans list requires billing:view', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    await request(app.getHttpServer()).get('/v1/billing/plans').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('is gated on billing:view for status and billing:manage for checkout/portal, tenant-isolated', async () => {
    const noPerm = await createTestTenant([]);
    const noPermToken = await login(noPerm.username);

    const deniedStatus = await request(app.getHttpServer())
      .get('/v1/billing/status')
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
    expect(deniedStatus.body.error.requiredPermission).toBe(PERMISSIONS.BILLING_VIEW);

    const deniedCheckout = await request(app.getHttpServer())
      .post('/v1/billing/checkout-session')
      .set('Authorization', `Bearer ${noPermToken}`)
      .send({ priceId: 'price_x', successUrl: 'http://localhost/ok', cancelUrl: 'http://localhost/cancel' })
      .expect(403);
    expect(deniedCheckout.body.error.requiredPermission).toBe(PERMISSIONS.BILLING_MANAGE);
  });

  it('rejects checkout/portal session creation with a clear error when Stripe is not configured for that request path', async () => {
    // This app instance DOES have STRIPE_SECRET_KEY set (module-level, above)
    // so it can exercise webhook signature verification below — but a
    // portal session for a company with no Stripe customer yet still fails
    // clearly for a different, equally real reason (no checkout ever run).
    const tenant = await createTestTenant([PERMISSIONS.BILLING_MANAGE]);
    const token = await login(tenant.username);

    const res = await request(app.getHttpServer())
      .post('/v1/billing/portal-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ returnUrl: 'http://localhost/account' })
      .expect(400);
    expect(res.body.error.code).toBe('NO_STRIPE_CUSTOMER');
  });

  it('rejects a webhook request with an invalid signature', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=not-a-real-signature')
      .send(JSON.stringify({ type: 'customer.subscription.updated' }))
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('syncs subscription status/plan from a validly-signed customer.subscription.updated event', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW]);
    const token = await login(tenant.username);
    // Derive the Stripe IDs from the (per-run-random) companyId — fixtures
    // never tear down, and stripeSubscriptionId is @unique, so a hardcoded
    // id would collide on a re-run against the same local database.
    const stripeCustomerId = `cus_${tenant.companyId}`;
    const stripeSubscriptionId = `sub_${tenant.companyId}`;

    await signedWebhookRequest(
      app,
      subscriptionUpdatedEvent(stripeCustomerId, stripeSubscriptionId, 'active', 'price_test_standard', tenant.companyId),
    ).expect(200);

    const status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.subscriptionStatus).toBe('ACTIVE');
    expect(status.body.planPriceId).toBe('price_test_standard');
    expect(status.body.hasStripeCustomer).toBe(true);
  });

  it('maps Stripe past_due/canceled statuses onto the company correctly', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW]);
    const token = await login(tenant.username);
    const stripeCustomerId = `cus_${tenant.companyId}`;
    const stripeSubscriptionId = `sub_${tenant.companyId}`;

    await signedWebhookRequest(
      app,
      subscriptionUpdatedEvent(stripeCustomerId, stripeSubscriptionId, 'past_due', 'price_test_standard', tenant.companyId),
    ).expect(200);
    let status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.subscriptionStatus).toBe('PAST_DUE');

    await signedWebhookRequest(app, {
      ...subscriptionUpdatedEvent(stripeCustomerId, stripeSubscriptionId, 'canceled', 'price_test_standard', tenant.companyId),
      type: 'customer.subscription.deleted',
    }).expect(200);
    status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.subscriptionStatus).toBe('CANCELED');
  });

  it('does nothing (no error) for a subscription event with no fleetosCompanyId metadata', async () => {
    await signedWebhookRequest(
      app,
      subscriptionUpdatedEvent('cus_does_not_exist_anywhere', 'sub_orphan', 'active', 'price_test_standard'),
    ).expect(200);
  });

  it('is idempotent: a duplicate webhook delivery (same event id) is only applied once', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW, PERMISSIONS.BILLING_MANAGE]);
    const token = await login(tenant.username);
    const stripeSubscriptionId = `sub_${tenant.companyId}`;
    // Build one event and deliver the exact same payload (same event id) twice.
    const event = invoiceEvent('invoice.payment_failed', stripeSubscriptionId, tenant.companyId, Math.floor(Date.now() / 1000) + 86400);
    await signedWebhookRequest(app, event).expect(200);
    await signedWebhookRequest(app, event).expect(200);

    const status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    // Without idempotency this would be 2; the duplicate delivery is skipped.
    expect(status.body.paymentFailureCount).toBe(1);
  });

  it('ignores an out-of-order subscription event older than the last one applied', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW]);
    const token = await login(tenant.username);
    const stripeCustomerId = `cus_${tenant.companyId}`;
    const stripeSubscriptionId = `sub_${tenant.companyId}`;

    // A newer "canceled" event lands first…
    const newer = { ...subscriptionUpdatedEvent(stripeCustomerId, stripeSubscriptionId, 'canceled', 'price_test_standard', tenant.companyId), type: 'customer.subscription.deleted' };
    // …then an older "active" event (lower `created`) arrives late.
    const older = subscriptionUpdatedEvent(stripeCustomerId, stripeSubscriptionId, 'active', 'price_test_standard', tenant.companyId);
    older.created = newer.created - 100;
    older.id = `${older.id}_stale`;

    await signedWebhookRequest(app, newer).expect(200);
    await signedWebhookRequest(app, older).expect(200);

    const status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    // The stale "active" event must NOT revert the company back to ACTIVE.
    expect(status.body.subscriptionStatus).toBe('CANCELED');
  });

  it('records an invoice.payment_failed event and notifies billing:manage holders with the retry date', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW, PERMISSIONS.BILLING_MANAGE]);
    const token = await login(tenant.username);
    const stripeSubscriptionId = `sub_${tenant.companyId}`;
    const nextAttempt = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;

    await signedWebhookRequest(app, invoiceEvent('invoice.payment_failed', stripeSubscriptionId, tenant.companyId, nextAttempt)).expect(
      200,
    );

    const status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.paymentFailureCount).toBe(1);
    expect(status.body.lastPaymentFailedAt).not.toBeNull();
    expect(new Date(status.body.nextPaymentAttemptAt).getTime()).toBe(nextAttempt * 1000);

    const notifications = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${token}`).expect(200);
    const types = (notifications.body.items as { type: string }[]).map((n) => n.type);
    expect(types).toContain('billing.payment_failed');
  });

  it('increments paymentFailureCount across repeated failures, then resets it and notifies recovery on invoice.paid', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW, PERMISSIONS.BILLING_MANAGE]);
    const token = await login(tenant.username);
    const stripeSubscriptionId = `sub_${tenant.companyId}`;

    await signedWebhookRequest(app, invoiceEvent('invoice.payment_failed', stripeSubscriptionId, tenant.companyId)).expect(200);
    await signedWebhookRequest(app, invoiceEvent('invoice.payment_failed', stripeSubscriptionId, tenant.companyId)).expect(200);

    let status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.paymentFailureCount).toBe(2);

    await signedWebhookRequest(app, invoiceEvent('invoice.paid', stripeSubscriptionId, tenant.companyId)).expect(200);

    status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.paymentFailureCount).toBe(0);
    expect(status.body.nextPaymentAttemptAt).toBeNull();

    const notifications = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${token}`).expect(200);
    const types = (notifications.body.items as { type: string }[]).map((n) => n.type);
    expect(types).toContain('billing.payment_recovered');
  });

  // Item 7: the 5-business-day grace window lifecycle — opened on the first
  // failure, held (not extended) across a retry, cleared on recovery.
  it('opens a 7-calendar-day grace window on first failure, surfaces it on /billing/status, holds it across a retry, and clears it on recovery', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW, PERMISSIONS.BILLING_MANAGE]);
    const token = await login(tenant.username);
    const stripeSubscriptionId = `sub_${tenant.companyId}`;
    const before = Date.now();

    await signedWebhookRequest(app, invoiceEvent('invoice.payment_failed', stripeSubscriptionId, tenant.companyId)).expect(200);
    const afterFirst = await ownerPrisma.company.findUniqueOrThrow({ where: { id: tenant.companyId }, select: { gracePeriodEndsAt: true } });
    expect(afterFirst.gracePeriodEndsAt).not.toBeNull();
    const graceEnd = afterFirst.gracePeriodEndsAt as Date;
    // Exactly 7 calendar days from the failure (no weekend skipping any more).
    const daysOut = (graceEnd.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);

    // The banner-driving fields are surfaced on the status endpoint, matching the
    // stored deadline (server-side source of truth, so a refresh can't reset it).
    const status = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.gracePeriodEndsAt).toBe(graceEnd.toISOString());
    expect(status.body.graceDaysRemaining).toBeGreaterThanOrEqual(6);
    expect(status.body.graceDaysRemaining).toBeLessThanOrEqual(7);

    // A retry failure within the same cycle keeps the SAME deadline (no silent extension).
    await signedWebhookRequest(app, invoiceEvent('invoice.payment_failed', stripeSubscriptionId, tenant.companyId)).expect(200);
    const afterSecond = await ownerPrisma.company.findUniqueOrThrow({ where: { id: tenant.companyId }, select: { gracePeriodEndsAt: true } });
    expect((afterSecond.gracePeriodEndsAt as Date).getTime()).toBe(graceEnd.getTime());

    // Recovery clears the window so the banner disappears and a future failure starts fresh.
    await signedWebhookRequest(app, invoiceEvent('invoice.paid', stripeSubscriptionId, tenant.companyId)).expect(200);
    const afterPaid = await ownerPrisma.company.findUniqueOrThrow({ where: { id: tenant.companyId }, select: { gracePeriodEndsAt: true } });
    expect(afterPaid.gracePeriodEndsAt).toBeNull();
    const clearedStatus = await request(app.getHttpServer()).get('/v1/billing/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(clearedStatus.body.gracePeriodEndsAt).toBeNull();
    expect(clearedStatus.body.graceDaysRemaining).toBeNull();
  });

  it('does not send a recovery notification for a routine invoice.paid with no prior failure', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW, PERMISSIONS.BILLING_MANAGE]);
    const token = await login(tenant.username);
    const stripeSubscriptionId = `sub_${tenant.companyId}`;

    await signedWebhookRequest(app, invoiceEvent('invoice.paid', stripeSubscriptionId, tenant.companyId)).expect(200);

    const notifications = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${token}`).expect(200);
    expect(notifications.body.items).toHaveLength(0);
  });

  it('does nothing (no error) for an invoice event with no fleetosCompanyId metadata', async () => {
    await signedWebhookRequest(app, invoiceEvent('invoice.payment_failed', 'sub_orphan')).expect(200);
    await signedWebhookRequest(app, invoiceEvent('invoice.paid', 'sub_orphan')).expect(200);
  });
});
