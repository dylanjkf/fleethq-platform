/**
 * Phase 5b (21-Admin-Platform/Overview.md): admin-managed feature flags,
 * evaluated on the customer side by FeatureFlagsService/FeatureFlagGuard.
 * Includes proof that the gate is real, not decorative: disabling the
 * `operational_recommendations` flag actually blocks that customer route,
 * and a per-company override can carve out an exception.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Feature Flags', () => {
  let app: INestApplication;
  let adminToken: string;
  let viewOnlyToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();

    const admin = await createTestAdmin([ADMIN_PERMISSIONS.FEATURE_FLAGS_VIEW, ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = loginRes.body.accessToken as string;

    const viewOnlyAdmin = await createTestAdmin([ADMIN_PERMISSIONS.FEATURE_FLAGS_VIEW]);
    const viewOnlyLoginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: viewOnlyAdmin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    viewOnlyToken = viewOnlyLoginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  async function customerLogin(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('rejects an admin route request without a token', async () => {
    await request(app.getHttpServer()).get('/v1/admin/feature-flags').expect(401);
  });

  it('creates, lists, updates, and deletes a flag; rejects a duplicate key and a view-only admin', async () => {
    const key = `test_flag_${randomUUID().slice(0, 8)}`;

    const createRes = await request(app.getHttpServer())
      .post('/v1/admin/feature-flags')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key, name: 'Test Flag', description: 'A flag for testing.' })
      .expect(201);
    expect(createRes.body.globalEnabled).toBe(true);
    const flagId = createRes.body.id as string;

    await request(app.getHttpServer())
      .post('/v1/admin/feature-flags')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key, name: 'Dup', description: 'dup' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/v1/admin/feature-flags')
      .set('Authorization', `Bearer ${viewOnlyToken}`)
      .send({ key: `${key}_2`, name: 'x', description: 'y' })
      .expect(403);

    const listRes = await request(app.getHttpServer()).get('/v1/admin/feature-flags').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(listRes.body.some((f: { id: string }) => f.id === flagId)).toBe(true);

    await request(app.getHttpServer())
      .patch(`/v1/admin/feature-flags/${flagId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ globalEnabled: false })
      .expect(200);

    await request(app.getHttpServer()).delete(`/v1/admin/feature-flags/${flagId}`).set('Authorization', `Bearer ${adminToken}`).expect(200);

    const afterDeleteRes = await request(app.getHttpServer()).get('/v1/admin/feature-flags').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(afterDeleteRes.body.some((f: { id: string }) => f.id === flagId)).toBe(false);
  });

  it('404s setting an override for a flag key that does not exist', async () => {
    const tenant = await createTestTenant([]);
    await request(app.getHttpServer())
      .put(`/v1/admin/organisations/${tenant.companyId}/feature-flags/no_such_flag`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
      .expect(404);
  });

  describe('Real gate: operational_recommendations', () => {
    it('an unknown flag key fails open (route works with no flag row at all)', async () => {
      const tenant = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW]);
      const token = await customerLogin(tenant.username);
      await request(app.getHttpServer())
        .get('/v1/operational-recommendations/maintenance-priority')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('disabling the flag globally blocks the route with 403 FEATURE_DISABLED, and a per-company override re-enables it', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/v1/admin/feature-flags')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ key: 'operational_recommendations', name: 'Operational Recommendations', description: 'AI-derived suggestions.', globalEnabled: false })
        .expect(201);

      const blockedTenant = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW]);
      const blockedToken = await customerLogin(blockedTenant.username);
      const blockedRes = await request(app.getHttpServer())
        .get('/v1/operational-recommendations/maintenance-priority')
        .set('Authorization', `Bearer ${blockedToken}`)
        .expect(403);
      expect(blockedRes.body.error.code).toBe('FEATURE_DISABLED');

      const exceptionTenant = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW]);
      await request(app.getHttpServer())
        .put(`/v1/admin/organisations/${exceptionTenant.companyId}/feature-flags/operational_recommendations`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enabled: true })
        .expect(200);

      const exceptionToken = await customerLogin(exceptionTenant.username);
      await request(app.getHttpServer())
        .get('/v1/operational-recommendations/maintenance-priority')
        .set('Authorization', `Bearer ${exceptionToken}`)
        .expect(200);

      const overrideListRes = await request(app.getHttpServer())
        .get(`/v1/admin/organisations/${exceptionTenant.companyId}/feature-flags`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const entry = overrideListRes.body.find((f: { key: string }) => f.key === 'operational_recommendations');
      expect(entry.globalEnabled).toBe(false);
      expect(entry.override).toBe(true);
      expect(entry.effective).toBe(true);

      // Clearing the override reverts this company to the global default (disabled).
      await request(app.getHttpServer())
        .delete(`/v1/admin/organisations/${exceptionTenant.companyId}/feature-flags/operational_recommendations`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/v1/operational-recommendations/maintenance-priority')
        .set('Authorization', `Bearer ${exceptionToken}`)
        .expect(403);

      await request(app.getHttpServer()).delete(`/v1/admin/feature-flags/${createRes.body.id}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    });

    it('the customer /v1/feature-flags endpoint reflects the evaluated state', async () => {
      const flagRes = await request(app.getHttpServer())
        .post('/v1/admin/feature-flags')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ key: 'customer_visible_flag', name: 'Visible', description: 'x', globalEnabled: false })
        .expect(201);

      const tenant = await createTestTenant([]);
      const token = await customerLogin(tenant.username);
      const res = await request(app.getHttpServer()).get('/v1/feature-flags').set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body.customer_visible_flag).toBe(false);

      await request(app.getHttpServer()).delete(`/v1/admin/feature-flags/${flagRes.body.id}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    });
  });
});
