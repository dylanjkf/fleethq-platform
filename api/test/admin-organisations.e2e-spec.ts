/**
 * Phase 2 (21-Admin-Platform/Overview.md): organisation lifecycle management
 * from the FleetHQ admin platform, plus proof that suspension/archival
 * actually blocks customer access — not just a DB flag with no effect.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, addUserToCompany, createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, ensureAdminPermissions, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Organisations', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    await ensureAdminPermissions();
    app = await buildTestApp();
    const admin = await createTestAdmin([
      ADMIN_PERMISSIONS.ORGANISATIONS_VIEW,
      ADMIN_PERMISSIONS.ORGANISATIONS_CREATE,
      ADMIN_PERMISSIONS.ORGANISATIONS_SUSPEND,
      ADMIN_PERMISSIONS.ORGANISATIONS_ARCHIVE,
      ADMIN_PERMISSIONS.ORGANISATIONS_EDIT,
      ADMIN_PERMISSIONS.ORGANISATIONS_IMPERSONATE,
      ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE,
    ]);
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

  it('lists and fetches an organisation', async () => {
    const tenant = await createTestTenant([]);

    const listRes = await request(app.getHttpServer())
      .get('/v1/admin/organisations')
      .query({ page: 1, pageSize: 200 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(listRes.body.items.some((c: { id: string }) => c.id === tenant.companyId)).toBe(true);

    const detailRes = await request(app.getHttpServer())
      .get(`/v1/admin/organisations/${tenant.companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(detailRes.body.users.some((u: { username: string }) => u.username === tenant.username)).toBe(true);
  });

  it('rejects an admin route request without a token', async () => {
    await request(app.getHttpServer()).get('/v1/admin/organisations').expect(401);
  });

  it('suspending an organisation blocks a fresh customer login', async () => {
    const tenant = await createTestTenant([]);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Non-payment' })
      .expect(200);

    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD });
    expect(loginRes.status).toBe(401);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
  });

  it('suspending an organisation kills an already-issued customer session on its next request', async () => {
    const tenant = await createTestTenant([]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
    const token = loginRes.body.accessToken as string;

    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Abuse' })
      .expect(200);

    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('archives and unarchives an organisation, and refuses to suspend an archived one', async () => {
    const tenant = await createTestTenant([]);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Should fail' })
      .expect(400);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/unarchive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: tenant.username, password: TEST_PASSWORD })
      .expect(200);
  });

  it('updates the trial end date', async () => {
    const tenant = await createTestTenant([]);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const res = await request(app.getHttpServer())
      .patch(`/v1/admin/organisations/${tenant.companyId}/trial`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ trialEndsAt: future })
      .expect(200);
    expect(new Date(res.body.trialEndsAt).toISOString()).toBe(future);

    await request(app.getHttpServer())
      .patch(`/v1/admin/organisations/${tenant.companyId}/trial`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ trialEndsAt: null })
      .expect(200);
  });

  it('impersonates a customer user and mints a token usable against the customer API', async () => {
    const tenant = await createTestTenant([]);

    const res = await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: tenant.userId })
      .expect(200);
    expect(typeof res.body.accessToken).toBe('string');

    const meRes = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(meRes.body.userId ?? meRes.body.id).toBeDefined();
  });

  it('refuses to impersonate into a suspended organisation', async () => {
    const tenant = await createTestTenant([]);
    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/suspend`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Investigation' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/impersonate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: tenant.userId })
      .expect(409);
  });

  it('creates a new customer user in an organisation who can then log in', async () => {
    const tenant = await createTestTenant([]);
    const role = await addUserToCompany(tenant.companyId, []); // ensures a role exists we can reuse by re-fetching membership
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/organisations/${tenant.companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const roleId = detail.body.users.find((u: { userId: string }) => u.userId === role.userId).role.id;

    const createRes = await request(app.getHttpServer())
      .post(`/v1/admin/organisations/${tenant.companyId}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: `admin-created-${tenant.companyId}`, fullName: 'Support Created', roleId, password: 'AdminCreated1!' })
      .expect(201);
    expect(createRes.body.userId).toBeDefined();

    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: `admin-created-${tenant.companyId}`, password: 'AdminCreated1!' })
      .expect(200);
  });

  // Item 6 (trial length): a staff-provisioned org starts on the native no-card
  // trial for the canonical TRIAL_PERIOD_DAYS window (7 days) — proving the
  // single-source-of-truth length is actually granted end-to-end, not just a
  // constant. The window is ~7 days from now (allowing for request latency).
  it('provisions a new organisation with the standard 7-day native trial', async () => {
    const email = `neworg-${Date.now()}@example.com`;
    const before = Date.now();
    const createRes = await request(app.getHttpServer())
      .post('/v1/admin/organisations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'Trial Test Co', adminEmail: email })
      .expect(201);
    const companyId = createRes.body.companyId as string;

    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/organisations/${companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(detail.body.trialEndsAt).toBeTruthy();
    const daysOut = (new Date(detail.body.trialEndsAt).getTime() - before) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);
  });

  // The override path: passing trialDays:0 provisions an org with no native
  // trial (e.g. one going straight onto a paid plan).
  it('provisions with no trial when trialDays is 0', async () => {
    const email = `notrial-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post('/v1/admin/organisations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'No Trial Co', adminEmail: email, trialDays: 0 })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/v1/admin/organisations/${createRes.body.companyId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(detail.body.trialEndsAt).toBeNull();
  });
});
