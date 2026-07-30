/**
 * A3 billing entitlements: with enforcement on and a company on a limited plan,
 * the plan's operator limit is actually enforced at the API (402), and the
 * entitlements endpoint reports the resolved plan. Enforcement is gated by
 * BILLING_ENFORCED, set here for the file and torn down after so it can't leak
 * into other suites (which rely on the default permissive behaviour).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const STARTER_PRICE = 'price_starter_test';

describe('Billing entitlements (plan limits)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.BILLING_ENFORCED = 'true';
    process.env.STRIPE_PRICE_STARTER = STARTER_PRICE;
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    delete process.env.BILLING_ENFORCED;
    delete process.env.STRIPE_PRICE_STARTER;
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
  });

  it('a company with no subscription resolves to the Free tier', async () => {
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const ent = await request(app.getHttpServer()).get('/v1/billing/entitlements').set('Authorization', `Bearer ${token}`).expect(200);
    expect(ent.body.planKey).toBe('free');
    expect(ent.body.limits.maxOperators).toBe(3);
  });
});
