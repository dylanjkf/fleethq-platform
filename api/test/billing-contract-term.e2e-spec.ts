/**
 * The 12-month minimum-term lock-in (Part 2), verified through the REAL HTTP
 * routes rather than a service method — an earlier version of this suite called
 * `BillingService.releaseFromContract` directly, which turned out to be dead code
 * (zero callers): the live staff `cancel_for_cause` route is wired to
 * `AdminBillingService.releaseFromContract`, a different implementation. Testing
 * the route (not a hand-picked function) is what stops a refactor from silently
 * re-opening that "tested the wrong function" gap.
 *
 * Two parallel implementations exist by design: the CUSTOMER self-serve cancel
 * (`BillingService.cancelSubscription`, POST /v1/billing/cancel) carries the
 * CONTRACT_LOCKED gate; the STAFF surface (`AdminBillingService`, the
 * /admin/organisations/:id/billing routes) can cancel/release regardless (staff
 * override) and writes to both the staff admin-audit log AND the company's own
 * billing_audit_logs ledger.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { BillingService } from '../src/billing/billing.service';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

const ownerPrisma = new PrismaClient();
const IN_200_DAYS = () => new Date(Date.now() + 200 * 24 * 60 * 60 * 1000);

describe('Billing 12-month minimum term — real HTTP routes', () => {
  let app: INestApplication;
  let billing: BillingService;
  let adminToken: string;

  beforeAll(async () => {
    // The customer-side CONTRACT_LOCKED gate is inert unless enforcement is on.
    // Set for this suite only (per-worker env), torn down after.
    process.env.BILLING_CONTRACT_ENFORCED = 'true';
    await ensurePermissions();
    app = await buildTestApp();
    billing = app.get(BillingService);
    await ensureAssetClasses();

    const admin = await createTestAdmin([ADMIN_PERMISSIONS.BILLING_VIEW, ADMIN_PERMISSIONS.BILLING_MANAGE]);
    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = res.body.accessToken as string;
  });
  afterAll(async () => {
    delete process.env.BILLING_CONTRACT_ENFORCED;
    await app.close();
    await disconnectFixtures();
    await disconnectAdminFixtures();
    await ownerPrisma.$disconnect();
  });
  afterEach(() => jest.restoreAllMocks());

  /** A customer tenant with a live subscription still inside its 12-month term. */
  async function subscribedWithinTerm() {
    const tenant = await createTestTenant([PERMISSIONS.BILLING_MANAGE]);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: {
        subscriptionStatus: 'ACTIVE',
        stripeCustomerId: `cus_${randomUUID()}`,
        stripeSubscriptionId: `sub_${randomUUID()}`,
        subscriptionStartedAt: new Date(),
        contractEndsAt: IN_200_DAYS(),
        contractReleasedAt: null,
      },
    });
    return tenant;
  }
  async function customerToken(username: string): Promise<string> {
    const r = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return r.body.accessToken as string;
  }

  it('customer self-serve cancel is blocked with CONTRACT_LOCKED within the term (POST /v1/billing/cancel)', async () => {
    const tenant = await subscribedWithinTerm();
    const token = await customerToken(tenant.username);

    const res = await request(app.getHttpServer()).post('/v1/billing/cancel').set('Authorization', `Bearer ${token}`).expect(400);
    expect(res.body.error.code).toBe('CONTRACT_LOCKED');

    // The rejection happens before Stripe / any ledger write.
    const audit = await ownerPrisma.billingAuditLog.findFirst({ where: { companyId: tenant.companyId, eventType: 'SUBSCRIPTION_CANCELED' } });
    expect(audit).toBeNull();
  });

  it('staff cancel_for_cause via the real admin route releases the company AND writes a MANUAL_OVERRIDE ledger row', async () => {
    const tenant = await subscribedWithinTerm();

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/billing/release-contract`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'company shutting down' })
      .expect(200);
    expect(res.body.contractReleasedAt).toBeTruthy();

    const company = await ownerPrisma.company.findUniqueOrThrow({
      where: { id: tenant.companyId },
      select: { contractReleasedAt: true, contractReleaseReason: true },
    });
    expect(company.contractReleasedAt).not.toBeNull();
    expect(company.contractReleaseReason).toBe('company shutting down');

    // The company's own billing ledger records the override — this is the write
    // that the prior round's fix targeted on a dead function instead of here.
    const ledger = await ownerPrisma.billingAuditLog.findFirst({
      where: { companyId: tenant.companyId, eventType: 'MANUAL_OVERRIDE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(ledger).not.toBeNull();
    expect(ledger!.detail).toMatchObject({ action: 'cancel_for_cause', reason: 'company shutting down' });
    expect(ledger!.actorAdminId).toBeTruthy();
  });

  it('staff-initiated cancellation via the real admin route writes a SUBSCRIPTION_CANCELED ledger row', async () => {
    const tenant = await subscribedWithinTerm();

    // The admin cancel path retrieves then updates/cancels the Stripe sub.
    const retrieve = jest.fn().mockResolvedValue({ status: 'active', cancel_at_period_end: false });
    const update = jest.fn().mockResolvedValue({ id: 'sub_x', status: 'active', cancel_at_period_end: true });
    const cancel = jest.fn().mockResolvedValue({ id: 'sub_x', status: 'canceled', cancel_at_period_end: false });
    jest.spyOn(billing, 'getStripeClient').mockReturnValue({ subscriptions: { retrieve, update, cancel } } as never);

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/billing/cancel`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ atPeriodEnd: true })
      .expect(200);
    expect(res.body.subscriptionId).toBeTruthy();

    const ledger = await ownerPrisma.billingAuditLog.findFirst({
      where: { companyId: tenant.companyId, eventType: 'SUBSCRIPTION_CANCELED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(ledger).not.toBeNull();
    expect(ledger!.detail).toMatchObject({ via: 'staff' });
    expect(ledger!.actorAdminId).toBeTruthy();
  });
});
