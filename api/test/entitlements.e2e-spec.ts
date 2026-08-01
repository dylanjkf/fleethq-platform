/**
 * A3 billing entitlements: with enforcement on and a company on a limited plan,
 * the plan's operator limit is actually enforced at the API (402), and the
 * entitlements endpoint reports the resolved plan. Enforcement is gated by
 * BILLING_ENFORCED, set here for the file and torn down after so it can't leak
 * into other suites (which rely on the default permissive behaviour).
 *
 * Auth/Billing Platform Phase 9 (usage & feature limit depth) extends this
 * file with: the asset-limit path (parity with operators — same mechanism,
 * previously untested), live usage counters on the entitlements response,
 * and the `forms`/`intelligence` feature gates (declared in every tier since
 * A3 but never actually enforced server-side until this phase).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const STARTER_PRICE = 'price_starter_test';
const PRO_PRICE = 'price_pro_test';

describe('Billing entitlements (plan limits)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.BILLING_ENFORCED = 'true';
    process.env.STRIPE_PRICE_STARTER = STARTER_PRICE;
    process.env.STRIPE_PRICE_PRO = PRO_PRICE;
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    delete process.env.BILLING_ENFORCED;
    delete process.env.STRIPE_PRICE_STARTER;
    delete process.env.STRIPE_PRICE_PRO;
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('reports the resolved plan and enforces the operator limit', async () => {
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_CREATE]);
    // Put the company on the Starter plan (limit: 10 operators).
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: STARTER_PRICE },
    });
    const token = await login(tenant.username);

    const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
    expect(ent.body).toMatchObject({ planKey: 'starter', enforced: true });
    expect(ent.body.limits.maxOperators).toBe(10);
    expect(ent.body.usage.operators).toBe(0);

    // Fill the plan to its limit…
    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer())
        .post('/v1/operators')
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: `Driver ${i}` })
        .expect(201);
    }
    // …and the next one is refused with 402 PLAN_LIMIT_REACHED.
    const overLimit = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'One too many' })
      .expect(402);
    expect(overLimit.body.error.code).toBe('PLAN_LIMIT_REACHED');

    // The usage counter reflects the real count, not just the limit.
    const after = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.usage.operators).toBe(10);
  });

  it('reports the resolved plan and enforces the asset limit (parity with operators)', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE]);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: STARTER_PRICE },
    });
    const token = await login(tenant.username);

    const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
    expect(ent.body.limits.maxAssets).toBe(10);
    expect(ent.body.usage.assets).toBe(0);

    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer())
        .post('/v1/assets')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Truck ${i}` })
        .expect(201);
    }
    const overLimit = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'One too many' })
      .expect(402);
    expect(overLimit.body.error.code).toBe('PLAN_LIMIT_REACHED');
    expect(overLimit.body.error.resource).toBe('assets');

    const after = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.usage.assets).toBe(10);
  });

  it('a company with no subscription resolves to the Free tier', async () => {
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
    expect(ent.body.planKey).toBe('free');
    expect(ent.body.limits.maxOperators).toBe(3);
  });

  it('gates the forms/intelligence plan features independently of the count limits (FEATURE_NOT_IN_PLAN)', async () => {
    // Free tier (no subscription) has neither declared feature.
    const free = await createTestTenant([PERMISSIONS.FORMS_VIEW, PERMISSIONS.MAINTENANCE_VIEW]);
    const freeToken = await login(free.username);
    const freeForms = await request(app.getHttpServer()).get('/v1/form-templates').set('Authorization', `Bearer ${freeToken}`).expect(402);
    expect(freeForms.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    const freeIntelligence = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${freeToken}`)
      .expect(402);
    expect(freeIntelligence.body.error.code).toBe('FEATURE_NOT_IN_PLAN');

    // Starter has `forms` but not `intelligence`.
    const starter = await createTestTenant([PERMISSIONS.FORMS_VIEW, PERMISSIONS.MAINTENANCE_VIEW]);
    await ownerPrisma.company.update({
      where: { id: starter.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: STARTER_PRICE },
    });
    const starterToken = await login(starter.username);
    await request(app.getHttpServer()).get('/v1/form-templates').set('Authorization', `Bearer ${starterToken}`).expect(200);
    await request(app.getHttpServer()).get('/v1/predictive-maintenance/signals').set('Authorization', `Bearer ${starterToken}`).expect(402);

    // Pro has both.
    const pro = await createTestTenant([PERMISSIONS.FORMS_VIEW, PERMISSIONS.MAINTENANCE_VIEW]);
    await ownerPrisma.company.update({
      where: { id: pro.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: PRO_PRICE },
    });
    const proToken = await login(pro.username);
    await request(app.getHttpServer()).get('/v1/form-templates').set('Authorization', `Bearer ${proToken}`).expect(200);
    await request(app.getHttpServer()).get('/v1/predictive-maintenance/signals').set('Authorization', `Bearer ${proToken}`).expect(200);
  });
});
