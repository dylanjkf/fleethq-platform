/**
 * Required coverage per 15-Testing/Testing_Strategy.md: "Multi-tenant
 * isolation: automated tests verifying no company's data is reachable through
 * another company's queries/tokens." Exercised at the API layer, through real
 * HTTP requests with real tokens — not by calling services directly — so this
 * actually proves the RLS + guard wiring, not just the service logic in isolation.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
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

async function loginAndGetToken(app: INestApplication, username: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .send({ username, password: TEST_PASSWORD })
    .expect(200);
  expect(res.body.status).toBe('authenticated');
  return res.body.accessToken as string;
}
