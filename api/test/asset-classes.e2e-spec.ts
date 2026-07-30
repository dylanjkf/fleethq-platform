/**
 * Customer-definable asset categories: built-ins are shared rows every tenant
 * reads (and cannot rename); a company can add its own, which then hold assets
 * and can back a checklist. Covers list (built-ins + own), create, the in-use
 * guard, tenant isolation of custom categories — and, in the second describe
 * block, *removing a built-in*, which is a per-company suppression rather than
 * an archive so it cannot affect other tenants.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MANAGE = [PERMISSIONS.ASSET_CLASS_MANAGE, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE];

describe('Asset categories', () => {
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

  async function login(username: string): Promise<Record<string, string>> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  it('lists built-ins, creates a custom category, and uses it on an asset', async () => {
    const tenant = await createTestTenant(MANAGE);
    const auth = await login(tenant.username);

    const initial = await request(app.getHttpServer()).get('/v1/asset-classes').set(auth).expect(200);
    const keys = initial.body.items.map((c: { key: string }) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['LAND', 'AIR', 'SEA']));
    expect(initial.body.items.every((c: { isBuiltIn: boolean }) => c.isBuiltIn)).toBe(true);

    const reefer = await request(app.getHttpServer()).post('/v1/asset-classes').set(auth).send({ name: 'Reefer Truck' }).expect(201);
    expect(reefer.body.key).toBe('REEFER_TRUCK');
    expect(reefer.body.isBuiltIn).toBe(false);

    // The custom category can hold an asset (by id and by key).
    const byId = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Reefer 1', assetClassId: reefer.body.id }).expect(201);
    expect(byId.body.assetClass.key).toBe('REEFER_TRUCK');
    const byKey = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Reefer 2', assetClass: 'REEFER_TRUCK' }).expect(201);
    expect(byKey.body.assetClass.id).toBe(reefer.body.id);

    // Archiving a category that still holds assets is blocked.
    const blocked = await request(app.getHttpServer()).post(`/v1/asset-classes/${reefer.body.id}/archive`).set(auth).expect(400);
    expect(blocked.body.error.code).toBe('ASSET_CLASS_IN_USE');
  });

  it('keeps custom categories tenant-isolated but shares built-ins', async () => {
    const a = await createTestTenant(MANAGE);
    const b = await createTestTenant(MANAGE);
    const authA = await login(a.username);
    const authB = await login(b.username);

    const forklift = await request(app.getHttpServer()).post('/v1/asset-classes').set(authA).send({ name: 'Forklift' }).expect(201);
    const bList = await request(app.getHttpServer()).get('/v1/asset-classes').set(authB).expect(200);
    expect(bList.body.items.map((c: { key: string }) => c.key)).not.toContain('FORKLIFT');
    // B can still create its own 'Forklift' — keys are unique per company, not globally.
    await request(app.getHttpServer()).post('/v1/asset-classes').set(authB).send({ name: 'Forklift' }).expect(201);
    // B can't edit A's category.
    await request(app.getHttpServer()).patch(`/v1/asset-classes/${forklift.body.id}`).set(authB).send({ name: 'Hijacked' }).expect(404);
  });

  it('requires asset_class:manage to create a category', async () => {
    const viewer = await createTestTenant([PERMISSIONS.ASSETS_VIEW]);
    const auth = await login(viewer.username);
    const res = await request(app.getHttpServer()).post('/v1/asset-classes').set(auth).send({ name: 'X' }).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ASSET_CLASS_MANAGE);
  });
});

/**
 * Removing a BUILT-IN category. A built-in is one shared row (company_id NULL)
 * that every tenant reads, so "remove" must not archive it — that would delete
 * the category for every customer. It is suppressed per company instead, which
 * is reversible and invisible to other tenants.
 */
describe('Asset categories — removing a built-in', () => {
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

  it('hides a built-in for this company only, reversibly, without touching other tenants', async () => {
    const a = await createTestTenant([PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSET_CLASS_MANAGE]);
    const b = await createTestTenant([PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSET_CLASS_MANAGE]);
    const authA = { Authorization: `Bearer ${await login(a.username)}` };
    const authB = { Authorization: `Bearer ${await login(b.username)}` };

    const before = await request(app.getHttpServer()).get('/v1/asset-classes').set(authA).expect(200);
    const builtIn = before.body.items.find((c: { isBuiltIn: boolean }) => c.isBuiltIn);
    expect(builtIn).toBeDefined();

    // Remove it for company A.
    const removed = await request(app.getHttpServer()).post(`/v1/asset-classes/${builtIn.id}/archive`).set(authA).expect(201);
    expect(removed.body).toMatchObject({ removed: 'hidden' });

    // Gone for A…
    const afterA = await request(app.getHttpServer()).get('/v1/asset-classes').set(authA).expect(200);
    expect(afterA.body.items.some((c: { id: string }) => c.id === builtIn.id)).toBe(false);

    // …but company B is completely unaffected (the shared row still exists).
    const afterB = await request(app.getHttpServer()).get('/v1/asset-classes').set(authB).expect(200);
    expect(afterB.body.items.some((c: { id: string }) => c.id === builtIn.id)).toBe(true);

    // Visible to A as hidden when explicitly asked, so it can be restored.
    const withHidden = await request(app.getHttpServer()).get('/v1/asset-classes?includeHidden=true').set(authA).expect(200);
    expect(withHidden.body.items.find((c: { id: string }) => c.id === builtIn.id)).toMatchObject({ isHidden: true });

    // Removing twice is a no-op, not a constraint error.
    await request(app.getHttpServer()).post(`/v1/asset-classes/${builtIn.id}/archive`).set(authA).expect(201);

    // Restore brings it back for A.
    await request(app.getHttpServer()).post(`/v1/asset-classes/${builtIn.id}/restore`).set(authA).expect(201);
    const restored = await request(app.getHttpServer()).get('/v1/asset-classes').set(authA).expect(200);
    expect(restored.body.items.some((c: { id: string }) => c.id === builtIn.id)).toBe(true);
  });

  it('refuses to remove a category that still has assets in it', async () => {
    const t = await createTestTenant([PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSET_CLASS_MANAGE]);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const list = await request(app.getHttpServer()).get('/v1/asset-classes').set(auth).expect(200);
    const builtIn = list.body.items.find((c: { isBuiltIn: boolean }) => c.isBuiltIn);

    await request(app.getHttpServer())
      .post('/v1/assets')
      .set(auth)
      .send({ name: 'Truck in category', assetClassId: builtIn.id })
      .expect(201);

    const res = await request(app.getHttpServer()).post(`/v1/asset-classes/${builtIn.id}/archive`).set(auth).expect(400);
    expect(res.body.error).toMatchObject({ code: 'ASSET_CLASS_IN_USE' });
  });
});
