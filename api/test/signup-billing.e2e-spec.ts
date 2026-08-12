/**
 * Per-asset billing + self-serve signup (19-Billing/Per_Asset_Billing.md,
 * Self_Serve_Signup.md). Exercises the revenue/security-critical mechanics
 * end-to-end against real Postgres:
 *  - the hard asset cap = purchased quantity, enforced at the API (402),
 *  - its race-safety under concurrent creates (the advisory-lock guarantee),
 *  - the CAP_BLOCKED audit trail,
 *  - idempotent, payment-first provisioning from a completed checkout, and the
 *    single-use instant-login that lands the new admin straight in the app,
 *  - the signup honeypot, and the abandoned-checkout expiry sweep.
 *
 * BILLING_ENFORCED + the per-asset price are set for this file only and torn
 * down after, so they can't leak into suites that rely on the default
 * permissive behaviour. Stripe itself is never called: provisioning is driven
 * with a plain fake session/subscription (the webhook already verified them),
 * and the best-effort Stripe metadata-tag/email are no-ops when unconfigured.
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
const PER_ASSET_PRICE = 'price_per_asset_test';

describe('Per-asset billing + self-serve signup', () => {
  let app: INestApplication;
  let signup: SignupService;
  let billing: BillingService;

  beforeAll(async () => {
    process.env.BILLING_ENFORCED = 'true';
    process.env.STRIPE_PRICE_PER_ASSET = PER_ASSET_PRICE;
    process.env.APP_BASE_URL = 'https://app.fleethq.test';
    app = await buildTestApp();
    signup = app.get(SignupService);
    billing = app.get(BillingService);
    await ensureAssetClasses();
    await ensurePermissions();
  });

  afterAll(async () => {
    delete process.env.BILLING_ENFORCED;
    delete process.env.STRIPE_PRICE_PER_ASSET;
    delete process.env.APP_BASE_URL;
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  /** A company on the per-asset plan with `quantity` paid slots. */
  async function perAssetCompany(quantity: number) {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: PER_ASSET_PRICE, assetQuantity: quantity },
    });
    return tenant;
  }

  const postAsset = (token: string, name: string) =>
    request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name });

  describe('the hard asset cap is the purchased quantity', () => {
    it('reports the per-asset plan and blocks the create past the paid quantity (402) + audits it', async () => {
      const tenant = await perAssetCompany(2);
      const token = await login(tenant.username);

      const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
      expect(ent.body).toMatchObject({ planKey: 'per_asset', enforced: true, assetQuantity: 2 });
      expect(ent.body.limits.maxAssets).toBe(2);

      await postAsset(token, 'Truck 1').expect(201);
      await postAsset(token, 'Truck 2').expect(201);
      const blocked = await postAsset(token, 'Truck 3 (over cap)').expect(402);
      expect(blocked.body.error.code).toBe('PLAN_LIMIT_REACHED');
      expect(blocked.body.error.resource).toBe('assets');
      expect(blocked.body.error.limit).toBe(2);

      const audits = await ownerPrisma.billingAuditLog.findMany({
        where: { companyId: tenant.companyId, eventType: 'CAP_BLOCKED' },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(audits[0].detail).toMatchObject({ resource: 'assets', limit: 2, attempted: 3 });
    });

    it('is race-safe: three concurrent creates at the last slot yield exactly one success', async () => {
      const tenant = await perAssetCompany(5);
      const token = await login(tenant.username);
      for (let i = 0; i < 4; i += 1) {
        await postAsset(token, `Seed ${i}`).expect(201);
      }

      // Three creates fired together for the single remaining slot. The advisory
      // lock must serialise them so only one commits.
      const statuses = await Promise.all(
        ['r1', 'r2', 'r3'].map((n) => postAsset(token, n).then((res) => res.status)),
      );
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 402)).toHaveLength(2);

      const live = await ownerPrisma.asset.count({ where: { companyId: tenant.companyId, archivedAt: null } });
      expect(live).toBe(5); // never 6 or 7
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
          requestedQuantity: 3,
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
        items: { data: [{ id: itemId, quantity: 3, price: { id: PER_ASSET_PRICE } }] },
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
        planPriceId: PER_ASSET_PRICE,
        assetQuantity: 3,
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
      expect(me.body).toMatchObject({ planKey: 'per_asset', assetQuantity: 3 });

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
          adminPassword: 'password123',
          quantity: 1,
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
     * it) and whose subscription lookup returns a per-asset subscription.
     */
    function fakeStripe(paidSessionId: string, subId: string, customerId: string, itemId: string, quantity: number) {
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
            items: { data: [{ id: itemId, quantity, price: { id: PER_ASSET_PRICE } }] },
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
          requestedQuantity: 2,
          hashedPassword: await bcrypt.hash(TEST_PASSWORD, 10),
          status: 'PENDING',
          createdAt: new Date(Date.now() - 20 * 60 * 1000), // older than the 10-min grace
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const cfg = jest.spyOn(billing, 'isConfigured').mockReturnValue(true);
      const client = jest.spyOn(billing, 'getStripeClient').mockReturnValue(fakeStripe(sessionId, subId, customerId, itemId, 2));
      try {
        const result = await signup.reconcileStuckSignups();
        expect(result.recovered).toBeGreaterThanOrEqual(1);
      } finally {
        cfg.mockRestore();
        client.mockRestore();
      }

      const companies = await ownerPrisma.company.findMany({ where: { name: companyName } });
      expect(companies).toHaveLength(1);
      expect(companies[0]).toMatchObject({ planPriceId: PER_ASSET_PRICE, assetQuantity: 2, stripeSubscriptionId: subId });
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
        .mockReturnValue(fakeStripe(sessionId, `sub_x_${suffix}`, `cus_x_${suffix}`, `si_x_${suffix}`, 1));
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
    // A per-asset company that is past due AND whose 5-business-day grace window
    // has already elapsed (gracePeriodEndsAt in the past) — the point at which the
    // read-only restriction actually applies (item 7).
    async function readOnlyCompany(gracePeriodEndsAt: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
      const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.BILLING_MANAGE]);
      await ownerPrisma.company.update({
        where: { id: tenant.companyId },
        data: {
          subscriptionStatus: 'PAST_DUE',
          planPriceId: PER_ASSET_PRICE,
          assetQuantity: 5,
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
      const tenant = await perAssetCompany(3);
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
