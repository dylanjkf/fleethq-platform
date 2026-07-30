/**
 * Warehouse is a genuine paid add-on: with billing enforcement on, a company
 * whose plan lacks the `warehouse` feature is rejected server-side with 402
 * FEATURE_NOT_IN_PLAN even when the user holds warehouse:view/manage — hiding
 * the module in the client is not the only thing standing between a Free plan
 * and the add-on. A plan that includes the feature is unaffected.
 *
 * BILLING_ENFORCED is set for this file and torn down after so it can't leak
 * into other suites (which rely on the default permissive behaviour).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const STARTER_PRICE = 'price_starter_paywall_test';
const PRO_PRICE = 'price_pro_paywall_test';
const MANAGER = [PERMISSIONS.WAREHOUSE_VIEW, PERMISSIONS.WAREHOUSE_MANAGE];

describe('Warehouse paywall (plan feature gate)', () => {
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

  /** Starter includes `core`+`forms` but NOT `warehouse`. */
  it('blocks warehouse reads and writes with 402 on a plan without the add-on', async () => {
    const tenant = await createTestTenant(MANAGER);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: STARTER_PRICE },
    });
    const auth = { Authorization: `Bearer ${await login(tenant.username)}` };

    const read = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(402);
    // HttpExceptionFilter normalises every error into a single `{ error: … }` envelope.
    expect(read.body.error).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', feature: 'warehouse' });

    // The write path is gated too — the paywall isn't read-only theatre.
    await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set(auth)
      .send({ sku: 'PAYWALL-1', name: 'Blocked item', quantity: 1 })
      .expect(402);
  });

  /** Pro includes `warehouse`, so the same calls succeed unchanged. */
  it('allows warehouse access on a plan that includes the add-on', async () => {
    const tenant = await createTestTenant(MANAGER);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: PRO_PRICE },
    });
    const auth = { Authorization: `Bearer ${await login(tenant.username)}` };

    await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set(auth)
      .send({ sku: 'PAYWALL-OK-1', name: 'Allowed item', quantity: 2 })
      .expect(201);
  });

  /**
   * A lapsed plan must not destroy data: the item created while entitled is
   * still there (just unreachable) after the company drops to a plan without
   * the add-on, and becomes readable again on re-upgrade.
   */
  it('retains warehouse data across a lapse and restores access on upgrade', async () => {
    const tenant = await createTestTenant(MANAGER);
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'ACTIVE', planPriceId: PRO_PRICE },
    });
    const auth = { Authorization: `Bearer ${await login(tenant.username)}` };
    await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set(auth)
      .send({ sku: 'RETAINED-1', name: 'Retained item', quantity: 5 })
      .expect(201);

    // Downgrade to a plan without `warehouse` — access is refused…
    await ownerPrisma.company.update({ where: { id: tenant.companyId }, data: { planPriceId: STARTER_PRICE } });
    await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(402);
    // …but the row is untouched in the database.
    const stillThere = await ownerPrisma.stockItem.findFirst({
      where: { companyId: tenant.companyId, sku: 'RETAINED-1' },
    });
    expect(stillThere).not.toBeNull();

    // Re-upgrade restores access to the same data.
    await ownerPrisma.company.update({ where: { id: tenant.companyId }, data: { planPriceId: PRO_PRICE } });
    const after = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    expect(after.body.items.some((i: { sku: string }) => i.sku === 'RETAINED-1')).toBe(true);
  });
});
