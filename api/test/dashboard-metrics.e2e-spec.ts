/**
 * Dashboard operations metrics: the live counts behind the Operations snapshot
 * and Fleet utilisation widgets. Every figure is derived from real rows — an
 * asset with an open maintenance job counts as "in workshop", a driver-raised
 * open job as an "open defect", an asset on an ASSIGNED dispatch job as
 * "on an active job". No trend, no fabricated delta.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { DashboardMetricsService } from '../src/dashboard-layouts/dashboard-metrics.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Dashboard metrics', () => {
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

  it('returns live operational counts (active / in-workshop / open defects / on active job)', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.ASSETS_VIEW,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.OPERATORS_CREATE,
      PERMISSIONS.MAINTENANCE_CREATE,
      PERMISSIONS.DISPATCH_CREATE,
      PERMISSIONS.DISPATCH_ASSIGN,
    ]);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const asset1 = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Truck 1' }).expect(201);
    const asset2 = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Truck 2' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Dana Driver' }).expect(201);

    // Asset 1 → an open maintenance job the driver raised: in workshop + an open defect.
    await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set(auth)
      .send({ assetId: asset1.body.id, title: 'Brake fault', reportedByOperatorId: operator.body.id })
      .expect(201);

    // Asset 2 → assigned to an in-progress dispatch job: on an active job.
    const job = await request(app.getHttpServer()).post('/v1/jobs').set(auth).send({ title: 'Run' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/assign`).set(auth).send({ assetId: asset2.body.id, operatorId: operator.body.id }).expect(201);

    const metrics = await request(app.getHttpServer()).get('/v1/dashboard/metrics').set(auth).expect(200);
    expect(metrics.body).toMatchObject({ assetsActive: 2, assetsInWorkshop: 1, servicesDue: 0, openDefects: 1, assetsOnActiveJob: 1 });
    // No prior-day snapshot yet, so no deltas are invented.
    expect(metrics.body.deltas).toBeNull();
    expect(metrics.body.comparedTo).toBeNull();
  });

  it('accumulates a daily utilisation snapshot and serves it as a trend', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.ASSETS_VIEW,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.OPERATORS_CREATE,
      PERMISSIONS.DISPATCH_CREATE,
      PERMISSIONS.DISPATCH_ASSIGN,
    ]);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const a1 = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'A1' }).expect(201);
    await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'A2' }).expect(201);
    const op = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Sam' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set(auth).send({ title: 'Run' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/assign`).set(auth).send({ assetId: a1.body.id, operatorId: op.body.id }).expect(201);

    // Empty until the scheduler records something.
    const before = await request(app.getHttpServer()).get('/v1/dashboard/utilisation-trend').set(auth).expect(200);
    expect(before.body.points).toEqual([]);

    // Two samples fold into today's row: 1 of 2 assets busy → a weighted average of 50%.
    const metrics = app.get(DashboardMetricsService);
    await metrics.recordSnapshot(tenant.companyId);
    await metrics.recordSnapshot(tenant.companyId);

    const trend = await request(app.getHttpServer()).get('/v1/dashboard/utilisation-trend?days=7').set(auth).expect(200);
    expect(trend.body.points).toHaveLength(1);
    expect(trend.body.points[0]).toMatchObject({ utilisation: 50, assetsOnActiveJob: 1, assetsActive: 2 });
    expect(trend.body.points[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('computes a real "vs yesterday" delta against the prior-day snapshot', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE]);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'T1' }).expect(201);
    await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'T2' }).expect(201);
    // Today: 2 active, 0 in workshop, 0 defects, 0 services due.

    // Seed a prior-day snapshot (one sample) to diff against: 5 active, 0 workshop, 3 defects, 2 due.
    const prisma = app.get(PrismaService);
    const yesterday = new Date();
    yesterday.setUTCHours(0, 0, 0, 0);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await prisma.withTenant(tenant.companyId, (tx) =>
      tx.utilisationSnapshot.create({
        data: { companyId: tenant.companyId, day: yesterday, busySum: 1, activeSum: 5, workshopSum: 0, defectsSum: 3, servicesDueSum: 2, sampleCount: 1 },
      }),
    );

    const metrics = await request(app.getHttpServer()).get('/v1/dashboard/metrics').set(auth).expect(200);
    expect(metrics.body.comparedTo).toBe(yesterday.toISOString().slice(0, 10));
    expect(metrics.body.deltas).toEqual({ assetsActive: -3, assetsInWorkshop: 0, servicesDue: -2, openDefects: -3 });
  });

  it('requires assets:view', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    const res = await request(app.getHttpServer()).get('/v1/dashboard/metrics').set('Authorization', `Bearer ${token}`).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ASSETS_VIEW);
  });
});
