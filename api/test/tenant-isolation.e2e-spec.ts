/**
 * Required coverage per 15-Testing/Testing_Strategy.md: "Multi-tenant
 * isolation: automated tests verifying no company's data is reachable through
 * another company's queries/tokens." Exercised at the API layer, through real
 * HTTP requests with real tokens — not by calling services directly — so this
 * actually proves the RLS + guard wiring, not just the service logic in isolation.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS, type PermissionKey } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

describe('Tenant isolation (Assets)', () => {
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

  it("does not expose company B's assets to company A, by list or by direct id", async () => {
    const allAssetPerms = [
      PERMISSIONS.ASSETS_VIEW,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.ASSETS_EDIT,
      PERMISSIONS.ASSETS_ARCHIVE,
    ];
    const tenantA = await createTestTenant(allAssetPerms);
    const tenantB = await createTestTenant(allAssetPerms);

    const tokenA = await loginAndGetToken(app, tenantA.username);
    const tokenB = await loginAndGetToken(app, tenantB.username);

    const createB = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Company B Truck' })
      .expect(201);
    const assetBId = createB.body.id as string;

    const createA = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Company A Truck' })
      .expect(201);
    const assetAId = createA.body.id as string;

    const listA = await request(app.getHttpServer())
      .get('/v1/assets')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const idsVisibleToA = listA.body.items.map((a: { id: string }) => a.id);
    expect(idsVisibleToA).toContain(assetAId);
    expect(idsVisibleToA).not.toContain(assetBId);

    // Direct fetch by id must 404, not 403 — company A shouldn't even learn
    // that a resource with that id exists in another tenant.
    await request(app.getHttpServer())
      .get(`/v1/assets/${assetBId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    // And company A can't archive company B's asset by guessing its id.
    await request(app.getHttpServer())
      .post(`/v1/assets/${assetBId}/archive`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });
});

/**
 * The Assets test above is the canonical, most-detailed proof (list + direct-id
 * read + cross-tenant mutation). This second suite extends the same invariant —
 * "company A can never see or reach company B's rows" — across the other
 * tenant-scoped resources that carry operational or personal data, so a
 * regression in any one entity's RLS/guard wiring is caught, not just Assets'.
 * Each case proves the two failure modes that matter: the row is absent from
 * A's list, and a direct fetch of B's id under A's token 404s (never 200, and
 * never 403 — A must not even learn the id exists).
 */
describe('Tenant isolation (operational + PII entities)', () => {
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

  /** Create resource `body` in both tenants and assert A can't see/reach B's. */
  async function assertIsolated(opts: {
    path: string;
    perms: PermissionKey[];
    bodyFor: (label: 'A' | 'B') => Record<string, unknown>;
  }): Promise<void> {
    const tenantA = await createTestTenant(opts.perms);
    const tenantB = await createTestTenant(opts.perms);
    const tokenA = await loginAndGetToken(app, tenantA.username);
    const tokenB = await loginAndGetToken(app, tenantB.username);

    const idB = (
      await request(app.getHttpServer())
        .post(opts.path)
        .set('Authorization', `Bearer ${tokenB}`)
        .send(opts.bodyFor('B'))
        .expect(201)
    ).body.id as string;
    const idA = (
      await request(app.getHttpServer())
        .post(opts.path)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(opts.bodyFor('A'))
        .expect(201)
    ).body.id as string;

    const listA = await request(app.getHttpServer())
      .get(opts.path)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const ids = listA.body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain(idA);
    expect(ids).not.toContain(idB);

    await request(app.getHttpServer())
      .get(`${opts.path}/${idB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  }

  it('isolates Operators (driver PII: name, email, phone)', async () => {
    await assertIsolated({
      path: '/v1/operators',
      perms: [PERMISSIONS.OPERATORS_VIEW, PERMISSIONS.OPERATORS_CREATE],
      bodyFor: (l) => ({ fullName: `Driver ${l}`, email: `driver-${l.toLowerCase()}@x.test` }),
    });
  });

  it('isolates Customers (consignee PII + addresses)', async () => {
    await assertIsolated({
      path: '/v1/customers',
      perms: [PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.CUSTOMERS_CREATE],
      bodyFor: (l) => ({ name: `Customer ${l}` }),
    });
  });

  it('isolates Parts (workshop inventory + costs)', async () => {
    await assertIsolated({
      path: '/v1/parts',
      perms: [PERMISSIONS.PARTS_VIEW, PERMISSIONS.PARTS_CREATE],
      bodyFor: (l) => ({ name: `Part ${l}`, quantityOnHand: 5, unitCost: 10 }),
    });
  });

  it('isolates Maintenance jobs (per-asset job history + costs)', async () => {
    const perms = [PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_CREATE, PERMISSIONS.ASSETS_CREATE];
    const tenantA = await createTestTenant(perms);
    const tenantB = await createTestTenant(perms);
    const tokenA = await loginAndGetToken(app, tenantA.username);
    const tokenB = await loginAndGetToken(app, tenantB.username);

    const assetFor = async (token: string) =>
      (await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Rig' }).expect(201)).body.id;
    const jobFor = async (token: string, assetId: string) =>
      (
        await request(app.getHttpServer())
          .post('/v1/maintenance-jobs')
          .set('Authorization', `Bearer ${token}`)
          .send({ assetId, title: 'Service' })
          .expect(201)
      ).body.id as string;

    const jobB = await jobFor(tokenB, await assetFor(tokenB));
    const jobA = await jobFor(tokenA, await assetFor(tokenA));

    const listA = await request(app.getHttpServer()).get('/v1/maintenance-jobs').set('Authorization', `Bearer ${tokenA}`).expect(200);
    const ids = listA.body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain(jobA);
    expect(ids).not.toContain(jobB);

    await request(app.getHttpServer()).get(`/v1/maintenance-jobs/${jobB}`).set('Authorization', `Bearer ${tokenA}`).expect(404);
  });
});

async function loginAndGetToken(app: INestApplication, username: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ username, password: TEST_PASSWORD })
    .expect(200);
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}
