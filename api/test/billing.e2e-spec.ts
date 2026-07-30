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
function subscriptionUpdatedEvent(customerId: string, subscriptionId: string, status: string, priceId: string, companyId?: string) {
  return {
    id: `evt_${subscriptionId}`,
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

  it('lists the purchasable plan tiers for the plan picker', async () => {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_VIEW]);
    const token = await login(tenant.username);

    const res = await request(app.getHttpServer()).get('/v1/billing/plans').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    const keys = res.body.plans.map((p: { key: string }) => p.key);
    expect(keys).toEqual(expect.arrayContaining(['starter', 'pro', 'enterprise']));
    const pro = res.body.plans.find((p: { key: string }) => p.key === 'pro');
    expect(pro.features).toEqual(expect.arrayContaining(['core', 'intelligence']));
    expect(pro).toHaveProperty('priceId');
    expect(pro).toHaveProperty('purchasable');
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
});
