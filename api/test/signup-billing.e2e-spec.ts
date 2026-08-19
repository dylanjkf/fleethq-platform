/**
 * Flat monthly billing + self-serve signup (19-Billing/Billing_And_Subscriptions.md,
 * Self_Serve_Signup.md). Exercises the revenue/security-critical mechanics
 * end-to-end against real Postgres under the FLAT pricing model:
 *  - asset count is purely operational — it no longer caps or bills, so adding
 *    assets has zero effect on the subscription and raises no CAP_BLOCKED audit,
 *  - idempotent, payment-first provisioning from a completed checkout, and the
 *    single-use instant-login that lands the new admin straight in the app,
 *  - the signup honeypot, the abandoned-checkout expiry sweep, and reconcile,
 *  - payment-failure read-only enforcement (unchanged by the pricing model).
 *
 * BILLING_ENFORCED + the flat monthly price are set for this file only and torn
 * down after. Stripe itself is never called: provisioning is driven with a plain
 * fake session/subscription (the webhook already verified them), and the
 * best-effort Stripe metadata-tag/email are no-ops when unconfigured.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { SignupService } from '../src/signup/signup.service';
import { BillingService } from '../src/billing/billing.service';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const FLAT_PRICE = 'price_flat_monthly_test';

describe('Flat monthly billing + self-serve signup', () => {
  let app: INestApplication;
  let signup: SignupService;
  let billing: BillingService;

  beforeAll(async () => {
    process.env.BILLING_ENFORCED = 'true';
    process.env.STRIPE_PRICE_MONTHLY = FLAT_PRICE;
    process.env.APP_BASE_URL = 'https://app.fleethq.test';
    app = await buildTestApp();
    signup = app.get(SignupService);
    billing = app.get(BillingService);
    await ensureAssetClasses();
    await ensurePermissions();
  });

  afterAll(async () => {
    delete process.env.BILLING_ENFORCED;
    delete process.env.STRIPE_PRICE_MONTHLY;
    delete process.env.APP_BASE_URL;
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  /** An active company on the flat monthly plan (no per-asset quantity exists). */
  async function flatCompany() {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: FLAT_PRICE, stripeSubscriptionId: `sub_${randomUUID()}` },
    });
    return tenant;
  }

  const postAsset = (token: string, name: string) =>
    request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name });

  describe('asset count is operational, not billed', () => {
    it('reports the flat plan with no asset cap, and adding many assets is never blocked or audited', async () => {
      const tenant = await flatCompany();
      const token = await login(tenant.username);

      const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
      expect(ent.body).toMatchObject({ planKey: 'flat', enforced: true });
      // No billing-driven asset cap under flat pricing.
      expect(ent.body.limits.maxAssets).toBeNull();
      // The per-asset-only field is gone from the entitlements payload.
      expect(ent.body).not.toHaveProperty('assetQuantity');

      // Create well beyond what any old per-asset cap would have allowed.
      for (let i = 0; i < 30; i += 1) {
        await postAsset(token, `Truck ${i}`).expect(201);
      }

      const capBlocks = await ownerPrisma.billingAuditLog.findMany({
        where: { companyId: tenant.companyId, eventType: 'CAP_BLOCKED' },
      });
      expect(capBlocks).toHaveLength(0);
    });

    it('adding/removing assets has zero effect on the Stripe subscription state stored on the company', async () => {
      const tenant = await flatCompany();
      const token = await login(tenant.username);
      const before = await ownerPrisma.company.findUniqueOrThrow({ where: { id: tenant.companyId } });

      const created = await postAsset(token, 'Reg-1').expect(201);
      await postAsset(token, 'Reg-2').expect(201);
      // Archive one back off — still no billing movement.
      await request(app.getHttpServer())
        .post(`/v1/assets/${created.body.id}/archive`)
        .set('Authorization', `Bearer ${token}`);

      const after = await ownerPrisma.company.findUniqueOrThrow({ where: { id: tenant.companyId } });
      // The subscription identity/price the company is billed on is untouched by asset churn.
      expect(after.planPriceId).toBe(before.planPriceId);
      expect(after.stripeSubscriptionId).toBe(before.stripeSubscriptionId);
      expect(after.subscriptionStatus).toBe(before.subscriptionStatus);
    });
  });

  describe('payment-first provisioning from a completed checkout', () => {
    it('provisions exactly once (idempotent) and instant-login lands an authenticated session', async () => {
      const suffix = randomUUID();
      const sessionId = `cs_test_${suffix}`;
      const email = `founder-${suffix}@example.com`;
      const companyName = `Provisioned Co ${suffix}`;

      // Stage the pending signup exactly as the public endpoint would (hashed password only).
      await ownerPrisma.pendingSignup.create({
        data: {
          stripeCheckoutSessionId: sessionId,
          companyName,
          adminEmail: email,
          adminName: 'Founder Person',
          requestedQuantity: 1,
          hashedPassword: await bcrypt.hash(TEST_PASSWORD, 10),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const nowSec = Math.floor(Date.now() / 1000);
      // Unique per run — stripeCustomerId/SubscriptionId are @unique, so reusing
      // fixed ids would collide with a prior run's provisioned company.
      const customerId = `cus_${suffix}`;
      const subId = `sub_${suffix}`;
      const itemId = `si_${suffix}`;
      const session = { id: sessionId, customer: customerId, subscription: subId } as never;
      const subscription = {
        id: subId,
        status: 'active',
        items: { data: [{ id: itemId, quantity: 1, price: { id: FLAT_PRICE } }] },
        current_period_start: nowSec,
        current_period_end: nowSec + 30 * 24 * 3600,
      } as never;

      // Deliver the webhook twice — Stripe redelivers; provisioning must be idempotent.
      await signup.provisionFromCompletedCheckout(session, subscription);
      await signup.provisionFromCompletedCheckout(session, subscription);

      const companies = await ownerPrisma.company.findMany({ where: { name: companyName } });
      expect(companies).toHaveLength(1);
      expect(companies[0]).toMatchObject({
        subscriptionStatus: 'ACTIVE',
        planPriceId: FLAT_PRICE,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subId,
        stripeSubscriptionItemId: itemId,
      });
      const users = await ownerPrisma.user.findMany({ where: { username: email } });
      expect(users).toHaveLength(1); // one admin, not two

      // Instant login: the success page's poll mints a working session.
      const status = await signup.getSignupStatus(sessionId, {});
      expect(status.status).toBe('completed');
      const accessToken = 'accessToken' in status ? status.accessToken : undefined;
      expect(accessToken).toBeTruthy();
      const me = await request(app.getHttpServer())
        .get('/v1/billing/entitlements')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({ planKey: 'flat' });

      // The login mint is single-use — a replay of the (browser-visible) session id can't re-login.
      const again = await signup.getSignupStatus(sessionId, {});
      expect(again).toMatchObject({ status: 'completed', alreadyClaimed: true });

      // SIGNUP_COMPLETED was audited against the new company.
      const audit = await ownerPrisma.billingAuditLog.findFirst({
        where: { companyId: companies[0].id, eventType: 'SIGNUP_COMPLETED' },
      });
      expect(audit).toBeTruthy();
    });
  });

  describe('signup endpoint guards', () => {
    it('rejects a filled honeypot without starting a checkout', async () => {
      await request(app.getHttpServer())
        .post('/v1/signup')
        .send({
          companyName: 'Spammer Pty',
          adminName: 'Bot',
          adminEmail: `bot-${randomUUID()}@example.com`,
          adminPassword: 'Password-123!',
          acceptedTerms: true,
          website: 'http://spam.example', // honeypot — real users never fill this
        })
        .expect(400);
    });
  });

  describe('abandoned checkout cleanup', () => {
    it('expires stale PENDING signups past their TTL', async () => {
      const suffix = randomUUID();
      const sessionId = `cs_stale_${suffix}`;
      await ownerPrisma.pendingSignup.create({
        data: {
          stripeCheckoutSessionId: sessionId,
          companyName: 'Abandoned Co',
          adminEmail: `stale-${suffix}@example.com`,
          adminName: 'Gone',
          requestedQuantity: 1,
          hashedPassword: 'x',
          status: 'PENDING',
          expiresAt: new Date(Date.now() - 1_000), // already expired
        },
      });

      const expired = await signup.expireStalePendingSignups();
      expect(expired).toBeGreaterThanOrEqual(1);
      const row = await ownerPrisma.pendingSignup.findUnique({ where: { stripeCheckoutSessionId: sessionId } });
      expect(row?.status).toBe('EXPIRED');
    });
  });

  describe('reconciliation of paid-but-unprovisioned signups', () => {
    // Clear any leftover PENDING rows (from earlier suites/runs) so the bounded
    // reconcile batch is exercised on exactly the rows each test stages.
    beforeAll(async () => {
      await ownerPrisma.pendingSignup.deleteMany({ where: { status: 'PENDING' } });
    });

    /**
     * A fake Stripe client whose Checkout Session lookup reports `paid + complete`
     * only for `paidSessionId` (any other id looks abandoned, so reconcile skips
     * it) and whose subscription lookup returns a flat monthly subscription.
     */
    function fakeStripe(paidSessionId: string, subId: string, customerId: string, itemId: string) {
      const nowSec = Math.floor(Date.now() / 1000);
      return {
        checkout: {
          sessions: {
            retrieve: async (id: string) =>
              id === paidSessionId
                ? { id, payment_status: 'paid', status: 'complete', customer: customerId, subscription: subId }
                : { id, payment_status: 'unpaid', status: 'open', customer: null, subscription: null },
          },
        },
        subscriptions: {
          retrieve: async () => ({
            id: subId,
            status: 'active',
            items: { data: [{ id: itemId, quantity: 1, price: { id: FLAT_PRICE } }] },
            current_period_start: nowSec,
            current_period_end: nowSec + 30 * 24 * 3600,
          }),
        },
      } as never;
    }

    it('recovers a stuck paid signup by re-driving provisioning (missed webhook)', async () => {
      const suffix = randomUUID();
      const sessionId = `cs_stuck_${suffix}`;
      const email = `stuck-${suffix}@example.com`;
      const companyName = `Recovered Co ${suffix}`;
      const customerId = `cus_rec_${suffix}`;
      const subId = `sub_rec_${suffix}`;
      const itemId = `si_rec_${suffix}`;

      await ownerPrisma.pendingSignup.create({
        data: {
          stripeCheckoutSessionId: sessionId,
          companyName,
          adminEmail: email,
          adminName: 'Stuck Founder',
          requestedQuantity: 1,
          hashedPassword: await bcrypt.hash(TEST_PASSWORD, 10),
          status: 'PENDING',
          createdAt: new Date(Date.now() - 20 * 60 * 1000), // older than the 10-min grace
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const cfg = jest.spyOn(billing, 'isConfigured').mockReturnValue(true);
      const client = jest.spyOn(billing, 'getStripeClient').mockReturnValue(fakeStripe(sessionId, subId, customerId, itemId));
      try {
        const result = await signup.reconcileStuckSignups();
        expect(result.recovered).toBeGreaterThanOrEqual(1);
      } finally {
        cfg.mockRestore();
        client.mockRestore();
      }

      const companies = await ownerPrisma.company.findMany({ where: { name: companyName } });
      expect(companies).toHaveLength(1);
      expect(companies[0]).toMatchObject({ planPriceId: FLAT_PRICE, stripeSubscriptionId: subId });
      const row = await ownerPrisma.pendingSignup.findUnique({ where: { stripeCheckoutSessionId: sessionId } });
      expect(row?.status).toBe('COMPLETED');
    });

    it('raises exactly one SIGNUP_PROVISION_FAILED alert when provisioning keeps failing', async () => {
      const suffix = randomUUID();
      const sessionId = `cs_fail_${suffix}`;
      const email = `fail-${suffix}@example.com`;

      await ownerPrisma.pendingSignup.create({
        data: {
          stripeCheckoutSessionId: sessionId,
          companyName: `Doomed Co ${suffix}`,
          adminEmail: email,
          adminName: 'Doomed',
          requestedQuantity: 1,
          hashedPassword: 'x',
          status: 'PENDING',
          createdAt: new Date(Date.now() - 20 * 60 * 1000),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const cfg = jest.spyOn(billing, 'isConfigured').mockReturnValue(true);
      const client = jest
        .spyOn(billing, 'getStripeClient')
        .mockReturnValue(fakeStripe(sessionId, `sub_x_${suffix}`, `cus_x_${suffix}`, `si_x_${suffix}`));
      const prov = jest.spyOn(signup, 'provisionFromCompletedCheckout').mockRejectedValue(new Error('db exploded'));
      try {
        await signup.reconcileStuckSignups();
        await signup.reconcileStuckSignups(); // a second sweep must not double-alert
      } finally {
        cfg.mockRestore();
        client.mockRestore();
        prov.mockRestore();
      }

      const alerts = await ownerPrisma.billingAuditLog.findMany({
        where: { eventType: 'SIGNUP_PROVISION_FAILED', detail: { path: ['sessionId'], equals: sessionId } },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].companyId).toBeNull();
      expect(alerts[0].detail).toMatchObject({ email, error: 'db exploded' });
    });
  });

  describe('payment-failure read-only enforcement', () => {
    // A flat-plan company that is past due AND whose 7-day grace window has already
    // elapsed (gracePeriodEndsAt in the past) — the point at which the read-only
    // restriction actually applies (item 7).
    async function readOnlyCompany(gracePeriodEndsAt: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.BILLING_MANAGE]);
      await ownerPrisma.company.update({
        where: { id: tenant.companyId },
        data: {
          subscriptionStatus: 'PAST_DUE',
          planPriceId: FLAT_PRICE,
          stripeSubscriptionId: `sub_ro_${randomUUID()}`,
          stripeCustomerId: `cus_ro_${randomUUID()}`,
          paymentFailureCount: 4,
          nextPaymentAttemptAt: null,
          gracePeriodEndsAt,
        },
      });
      return tenant;
    }

    it('blocks tenant-data writes with 402 BILLING_READ_ONLY while reads stay open', async () => {
      const tenant = await readOnlyCompany();
      const token = await login(tenant.username);

      const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
      expect(ent.body.billingReadOnly).toBe(true); // read works, and surfaces the state

      const blocked = await postAsset(token, 'Should not create').expect(402);
      expect(blocked.body.error.code).toBe('BILLING_READ_ONLY');

      const count = await ownerPrisma.asset.count({ where: { companyId: tenant.companyId, archivedAt: null } });
      expect(count).toBe(0); // the write never happened
    });

    it('still lets a past-due customer reach the billing pay-path (exempt route)', async () => {
      const tenant = await readOnlyCompany();
      const token = await login(tenant.username);
      // The read-only guard must NOT reject this — the @AllowWhenReadOnly exemption
      // lets it through to the service (which only errors because Stripe isn't
      // configured in this test). What matters is it's never the read-only block.
      const res = await request(app.getHttpServer())
        .post('/v1/billing/portal-session')
        .set('Authorization', `Bearer ${token}`)
        .send({ returnUrl: 'https://app.fleethq.test/billing' });
      expect(JSON.stringify(res.body)).not.toContain('BILLING_READ_ONLY');
    });

    it('does not affect a healthy active company', async () => {
      const tenant = await flatCompany();
      const token = await login(tenant.username);
      await postAsset(token, 'Healthy asset').expect(201);
    });

    // Item 7: DURING the grace window a past-due company is still fully writable —
    // the restriction only bites once the window elapses (proven by the test above).
    it('does NOT restrict a past-due company whose grace window is still open', async () => {
      const tenant = await readOnlyCompany(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)); // grace ends in 3 days
      const token = await login(tenant.username);

      const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
      expect(ent.body.billingReadOnly).toBe(false);

      await postAsset(token, 'Allowed during grace').expect(201);
    });
  });
});
