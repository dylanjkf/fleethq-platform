/**
 * Inventory concurrency guards (engineering-quality audit H1 + H2).
 *
 * These fire genuinely concurrent writes against the same row and assert the
 * bad outcome is impossible — a check-then-write race can't drive maintenance
 * parts stock negative (H1), and two warehouse adjustments can't lose one of
 * the two updates (H2). Both run against live Postgres so the row-level guard
 * (atomic conditional UPDATE / SELECT … FOR UPDATE) is actually exercised.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MAINT = [
  PERMISSIONS.PARTS_VIEW,
  PERMISSIONS.PARTS_CREATE,
  PERMISSIONS.MAINTENANCE_VIEW,
  PERMISSIONS.MAINTENANCE_CREATE,
  PERMISSIONS.ASSETS_CREATE,
];
const WAREHOUSE = [PERMISSIONS.WAREHOUSE_VIEW, PERMISSIONS.WAREHOUSE_MANAGE];

describe('Inventory concurrency guards', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('H1: N concurrent parts-usage submissions never oversell or drive stock negative', async () => {
    const tenant = await createTestTenant(MAINT);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const asset = (await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Truck 1' }).expect(201)).body.id;
    // Stock 4; 12 claimants each want 1 — at most 4 can ever succeed. Higher
    // fan-out makes the read-before-write overlap fire reliably: on the
    // unguarded check-then-decrement the relative UPDATE drives stock negative
    // and more than 4 requests "succeed"; the atomic guard makes that impossible.
    const CLAIMANTS = 12;
    const STOCK = 4;
    const part = (await request(app.getHttpServer()).post('/v1/parts').set(auth).send({ name: 'Filter', quantityOnHand: STOCK }).expect(201)).body.id;
    const jobs = await Promise.all(
      Array.from({ length: CLAIMANTS }, (_, i) =>
        request(app.getHttpServer()).post('/v1/maintenance-jobs').set(auth).send({ assetId: asset, title: `Job ${i}` }).expect(201).then((r) => r.body.id as string),
      ),
    );

    const results = await Promise.allSettled(
      jobs.map((jobId) => request(app.getHttpServer()).post(`/v1/maintenance-jobs/${jobId}/parts-used`).set(auth).send({ partId: part, quantity: 1 })),
    );

    const created = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201).length;
    const rejected = results.filter((r) => r.status === 'fulfilled' && r.value.status === 409).length;
    // Exactly the available stock succeeds; the rest are cleanly rejected.
    expect(created).toBe(STOCK);
    expect(rejected).toBe(CLAIMANTS - STOCK);

    const after = await request(app.getHttpServer()).get(`/v1/parts/${part}`).set(auth).expect(200);
    expect(after.body.quantityOnHand).toBe(0); // never negative, never over-decremented
  });

  it('H1: exact-stock race — only one of two claimants succeeds', async () => {
    const tenant = await createTestTenant(MAINT);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    const asset = (await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Truck 2' }).expect(201)).body.id;
    const part = (await request(app.getHttpServer()).post('/v1/parts').set(auth).send({ name: 'Blade', quantityOnHand: 1 }).expect(201)).body.id;
    const jobA = (await request(app.getHttpServer()).post('/v1/maintenance-jobs').set(auth).send({ assetId: asset, title: 'A' }).expect(201)).body.id;
    const jobB = (await request(app.getHttpServer()).post('/v1/maintenance-jobs').set(auth).send({ assetId: asset, title: 'B' }).expect(201)).body.id;

    const results = await Promise.allSettled([
      request(app.getHttpServer()).post(`/v1/maintenance-jobs/${jobA}/parts-used`).set(auth).send({ partId: part, quantity: 1 }),
      request(app.getHttpServer()).post(`/v1/maintenance-jobs/${jobB}/parts-used`).set(auth).send({ partId: part, quantity: 1 }),
    ]);
    const okCount = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201).length;
    expect(okCount).toBe(1);
    const after = await request(app.getHttpServer()).get(`/v1/parts/${part}`).set(auth).expect(200);
    expect(after.body.quantityOnHand).toBe(0);
  });

  it('H2: N concurrent stock adjustments are all reflected (no lost update)', async () => {
    const tenant = await createTestTenant(WAREHOUSE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    // Start at 0 and fire many concurrent +1 adjustments. Under the
    // read-modify-write race several land on the same starting value and
    // overwrite each other, so the total ends below N; the row lock forces
    // them to serialize so every increment survives.
    const ADJUSTMENTS = 12;
    const id = (await request(app.getHttpServer()).post('/v1/warehouse/stock').set(auth).send({ name: 'Bolts', quantity: 0 }).expect(201)).body.id;

    const results = await Promise.allSettled(
      Array.from({ length: ADJUSTMENTS }, (_, i) =>
        request(app.getHttpServer()).post(`/v1/warehouse/stock/${id}/adjust`).set(auth).send({ delta: 1, reason: `restock ${i}` }),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled' && r.value.status === 201)).toBe(true);

    const list = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    const item = list.body.items.find((i: { id: string }) => i.id === id);
    expect(item.quantity).toBe(ADJUSTMENTS); // every +1 survived; a lost update would leave < 12

    const ledger = await request(app.getHttpServer()).get(`/v1/warehouse/stock/${id}/adjustments`).set(auth).expect(200);
    expect(ledger.body.items).toHaveLength(ADJUSTMENTS);
  });
});
