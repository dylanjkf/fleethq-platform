/**
 * Required coverage per 15-Testing/Testing_Strategy.md: "Permission
 * enforcement: automated tests verifying that API endpoints reject
 * unauthorized actions regardless of what a client UI would show — this
 * should be tested at the API layer directly, not only through UI-driven
 * tests." No client UI exists yet, so this is the only place this guarantee
 * is currently verified.
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

describe('Permission enforcement', () => {
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

  it('rejects unauthenticated requests to a permissioned route', async () => {
    await request(app.getHttpServer()).get('/v1/assets').expect(401);
  });

  it('allows a granted action and rejects an ungranted one, with a consistent error shape', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.ASSETS_VIEW, PERMISSIONS.OPERATORS_VIEW]);
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: viewOnly.username, password: TEST_PASSWORD })
      .expect(200);
    const token = login.body.accessToken as string;

    // Granted: assets:view.
    await request(app.getHttpServer())
      .get('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Not granted: assets:create. Must be rejected server-side even though no
    // client UI exists to have hidden the button.
    const assetDenied = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should not be created' })
      .expect(403);
    expect(assetDenied.body.error.code).toBe('FORBIDDEN');
    expect(assetDenied.body.error.requiredPermission).toBe(PERMISSIONS.ASSETS_CREATE);

    // Not granted: operators:create — same check, different resource.
    const operatorDenied = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Should not be created' })
      .expect(403);
    expect(operatorDenied.body.error.code).toBe('FORBIDDEN');

    // Same envelope shape regardless of which resource was being accessed —
    // 12-API/API_Architecture.md acceptance criterion.
    expect(Object.keys(operatorDenied.body.error).sort()).toEqual(
      Object.keys(assetDenied.body.error).sort(),
    );
  });

  it('GET /v1/auth/me returns the caller\'s real granted permissions, not a cached/embedded set', async () => {
    const granted = [PERMISSIONS.ASSETS_VIEW, PERMISSIONS.OPERATORS_VIEW, PERMISSIONS.OPERATORS_EDIT];
    const tenant = await createTestTenant(granted);
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
    const token = login.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(me.body.username).toBe(tenant.username);
    expect([...me.body.permissions].sort()).toEqual([...granted].sort());
    expect(me.body.company.id).toBe(tenant.companyId);
  });

  it('accepts a built-in category (AIR) but rejects an unknown one', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE]);
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
    const token = login.body.accessToken as string;

    // AIR is a shared built-in category now — usable, not rejected.
    await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A plane', assetClass: 'AIR' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A mystery', assetClass: 'NOT_A_REAL_CATEGORY' })
      .expect(400);
    expect(res.body.error.code).toBe('ASSET_CLASS_NOT_FOUND');
  });
});
