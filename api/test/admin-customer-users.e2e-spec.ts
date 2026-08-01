/**
 * Phase 2 (21-Admin-Platform/Overview.md): cross-tenant customer-user
 * administration — disable/reactivate, unlock, MFA reset, password-reset
 * trigger — all against the real HTTP API.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { totp } from '../src/auth/mfa/totp';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Customer Users', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.CUSTOMER_USERS_VIEW, ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = loginRes.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  it('fetches a cross-tenant customer user view', async () => {
    const tenant = await createTestTenant([]);
    const res = await request(app.getHttpServer())
      .get(`/v1/admin/customer-users/${tenant.userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.username).toBe(tenant.username);
    expect(res.body.organisations.some((o: { companyId: string }) => o.companyId === tenant.companyId)).toBe(true);
  });

  it('rejects a customer-users route without a token', async () => {
    const tenant = await createTestTenant([]);
    await request(app.getHttpServer()).get(`/v1/admin/customer-users/${tenant.userId}`).expect(401);
  });

  it('disables and reactivates a customer user, blocking and then restoring login', async () => {
    const tenant = await createTestTenant([]);

    await request(app.getHttpServer())
      .post(`/v1/admin/customer-users/${tenant.userId}/disable`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(401);

    await request(app.getHttpServer())
      .post(`/v1/admin/customer-users/${tenant.userId}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
  });

  it('unlocks a locked-out customer user', async () => {
    const tenant = await createTestTenant([]);
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer()).post('/v1/auth/login').send({ username: tenant.username, password: 'wrong' });
    }
    // Confirm it's actually locked: even the correct password is rejected now.
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(401);

    await request(app.getHttpServer())
      .post(`/v1/admin/customer-users/${tenant.userId}/unlock`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
  });

  it('resets MFA so login no longer requires a challenge', async () => {
    const tenant = await createTestTenant([]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
    const token = loginRes.body.accessToken as string;

    const setupRes = await request(app.getHttpServer())
      .post('/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: totp(setupRes.body.secret) })
      .expect(200);

    const mfaLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
    expect(mfaLogin.body.status).toBe('mfa_required');

    await request(app.getHttpServer())
      .post(`/v1/admin/customer-users/${tenant.userId}/reset-mfa`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const afterReset = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
    expect(afterReset.body.status).toBe('authenticated');
  });

  it('reports whether an email is on file when triggering a password reset', async () => {
    const tenant = await createTestTenant([]);
    const res = await request(app.getHttpServer())
      .post(`/v1/admin/customer-users/${tenant.userId}/send-password-reset`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // createTestTenant doesn't set an email, so this should honestly report false.
    expect(res.body.emailOnFile).toBe(false);
  });
});
