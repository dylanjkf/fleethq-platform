/**
 * Phase 3 (21-Admin-Platform/Overview.md): the executive dashboard's real
 * aggregate data — organisation/user/fleet counts, subscription breakdown,
 * revenue (tolerant of billing being unconfigured, as it is in this test
 * environment), daily signups, and trials expiring soon.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Analytics', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.ANALYTICS_VIEW, ADMIN_PERMISSIONS.ORGANISATIONS_EDIT]);
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

  it('rejects analytics routes without a token', async () => {
    await request(app.getHttpServer()).get('/v1/admin/analytics/overview').expect(401);
  });

  it('reports a real aggregate overview, including at least the tenant just created', async () => {
    await createTestTenant([]);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/analytics/overview')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.organisations.total).toBeGreaterThanOrEqual(1);
    expect(res.body.organisations.active).toBeGreaterThanOrEqual(1);
    expect(res.body.users.total).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.fleet.assets).toBe('number');
    expect(typeof res.body.fleet.operators).toBe('number');
    expect(res.body.subscriptions).toBeDefined();
    expect(res.body.churn.windowDays).toBe(30);
    // Dashboard operations KPIs (inspections + defects) and the "today"/cancelled counters.
    expect(typeof res.body.organisations.cancelled).toBe('number');
    expect(typeof res.body.organisations.newToday).toBe('number');
    expect(typeof res.body.users.newToday).toBe('number');
    expect(typeof res.body.operations.inspections).toBe('number');
    expect(typeof res.body.operations.inspectionsToday).toBe('number');
    expect(typeof res.body.operations.openDefects).toBe('number');
    expect(typeof res.body.operations.defectsReportedToday).toBe('number');
    // No STRIPE_SECRET_KEY in this test environment — must honestly report
    // that, not fabricate a revenue number.
    expect(res.body.revenue.billingConfigured).toBe(false);
    expect(res.body.revenue.mrr).toBeNull();
  });

  it('returns a daily signup time series', async () => {
    await createTestTenant([]);
    const res = await request(app.getHttpServer())
      .get('/v1/admin/analytics/signups')
      .query({ days: 7 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const total = res.body.reduce((sum: number, row: { count: number }) => sum + row.count, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('lists organisations with a trial ending soon', async () => {
    const tenant = await createTestTenant([]);
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    await request(app.getHttpServer())
      .patch(`/v1/admin/organisations/${tenant.companyId}/trial`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ trialEndsAt: soon })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/analytics/trials-expiring')
      .query({ days: 7 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.some((o: { id: string }) => o.id === tenant.companyId)).toBe(true);
  });

  it('rejects an out-of-range days query', async () => {
    await request(app.getHttpServer())
      .get('/v1/admin/analytics/signups')
      .query({ days: 9999 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });
});
