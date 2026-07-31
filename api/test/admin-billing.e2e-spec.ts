/**
 * Phase 4 (21-Admin-Platform/Overview.md): FleetHQ staff billing operations
 * on top of the existing customer Stripe integration. STRIPE_SECRET_KEY is
 * deliberately left unset here (unlike test/billing.e2e-spec.ts, which sets
 * a fake key purely for offline webhook-signature verification) — every
 * mutating operation below targets a fresh test tenant with no
 * stripeCustomerId/stripeSubscriptionId, so it fails on the same
 * NO_STRIPE_CUSTOMER/NO_STRIPE_SUBSCRIPTION guard whether or not Stripe is
 * configured. Actually exercising a real Stripe API call (refund, coupon,
 * invoice creation against a live customer) would require a live Stripe test
 * account, which this offline test suite doesn't have — see
 * billing.e2e-spec.ts's own docstring for the same constraint on the
 * customer-facing checkout/portal tests.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Billing', () => {
  let app: INestApplication;
  let adminToken: string;
  let viewOnlyToken: string;
  let companyId: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();

    const admin = await createTestAdmin([ADMIN_PERMISSIONS.BILLING_VIEW, ADMIN_PERMISSIONS.BILLING_MANAGE]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = loginRes.body.accessToken as string;

    const viewOnlyAdmin = await createTestAdmin([ADMIN_PERMISSIONS.BILLING_VIEW]);
    const viewOnlyLoginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: viewOnlyAdmin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    viewOnlyToken = viewOnlyLoginRes.body.accessToken as string;

    const tenant = await createTestTenant([]);
    companyId = tenant.companyId;
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  it('rejects an admin route request without a token', async () => {
    await request(app.getHttpServer()).get(`/v1/admin/organisations/${companyId}/billing`).expect(401);
  });

  it('reports billing status for a company with no Stripe account yet', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/admin/organisations/${companyId}/billing`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.billingConfigured).toBe(false);
    expect(res.body.hasStripeCustomer).toBe(false);
    expect(res.body.hasStripeSubscription).toBe(false);
    expect(res.body.stripe).toBeNull();
  });

  it('refuses to list invoices for a company with no Stripe customer', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/admin/organisations/${companyId}/billing/invoices`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
    expect(res.body.error.code).toBe('NO_STRIPE_CUSTOMER');
  });

  it.each([
    ['refund', { invoiceId: 'in_fake' }],
    ['manual-invoice', { description: 'Onboarding fee', amountCents: 5000 }],
    ['credit-note', { invoiceId: 'in_fake', amountCents: 1000 }],
    ['retry-payment', { invoiceId: 'in_fake' }],
  ])('refuses %s for a company with no Stripe customer', async (route, body) => {
    const res = await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${companyId}/billing/${route}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body)
      .expect(400);
    expect(res.body.error.code).toBe('NO_STRIPE_CUSTOMER');
  });

  it.each(['coupon', 'cancel', 'reinstate'])('refuses %s for a company with no Stripe subscription', async (route) => {
    const res = await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${companyId}/billing/${route}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(route === 'coupon' ? { couponId: 'promo_fake' } : {})
      .expect(400);
    expect(res.body.error.code).toBe('NO_STRIPE_SUBSCRIPTION');
  });

  it('returns 404 for an organisation that does not exist', async () => {
    await request(app.getHttpServer())
      .get(`/v1/admin/organisations/00000000-0000-0000-0000-000000000000/billing`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('rejects a billing:manage action from a view-only admin', async () => {
    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${companyId}/billing/refund`)
      .set('Authorization', `Bearer ${viewOnlyToken}`)
      .send({ invoiceId: 'in_fake' })
      .expect(403);
  });

  it('rejects an invalid refund payload', async () => {
    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${companyId}/billing/refund`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ invoiceId: '', amountCents: -5 })
      .expect(400);
  });
});
