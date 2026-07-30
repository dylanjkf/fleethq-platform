/**
 * Operational reporting: aggregates deliveries (delivered/failed + rate),
 * checklist activity, open workshop jobs, a per-operator breakdown, a
 * maintenance cost trend, and fleet uptime over a date range. Verifies the
 * numbers reflect real activity and the permission gate.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.MAINTENANCE_CREATE,
  PERMISSIONS.MAINTENANCE_CLOSE,
];

const ownerPrisma = new PrismaClient();

describe('Operational reporting', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await ownerPrisma.$disconnect();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('summarises deliveries and computes the delivery rate', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops`).set('Authorization', `Bearer ${token}`).send({ stops: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }).expect(201);
    const full = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [s1, s2, s3] = full.body.stops;

    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${s1.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${s2.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${s3.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'FAILED', note: 'x' }).expect(201);

    const report = await request(app.getHttpServer()).get('/v1/reports/operations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(report.body.deliveries.total).toBe(3);
    expect(report.body.deliveries.delivered).toBe(2);
    expect(report.body.deliveries.failed).toBe(1);
    expect(report.body.deliveries.deliveryRatePct).toBe(67);
    expect(report.body.byOperator.length).toBeGreaterThanOrEqual(1);
  });

  it('reports impact: monthly series + headline totals of the value delivered', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Impact Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Impact Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops`).set('Authorization', `Bearer ${token}`).send({ stops: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }).expect(201);
    const full = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [s1, s2, s3] = full.body.stops;
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${s1.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${s2.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${s3.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'FAILED', note: 'x' }).expect(201);

    const res = await request(app.getHttpServer()).get('/v1/reports/impact').query({ months: 6 }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.range.months).toBe(6);
    expect(res.body.series).toHaveLength(6);
    expect(res.body.headline.deliveriesProven).toBe(2);
    expect(res.body.headline.failedDeliveries).toBe(1);
    expect(res.body.headline.deliveryRatePct).toBe(67);
    expect(res.body.headline.activeAssets).toBeGreaterThanOrEqual(1);
    // The current month bucket carries this activity.
    const current = res.body.series[res.body.series.length - 1];
    expect(current.delivered).toBe(2);
    expect(current.failed).toBe(1);
  });

  it('impact report requires reports:view', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    await request(app.getHttpServer()).get('/v1/reports/impact').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('assesses on-time delivery only for stops with a window, and breaks down failures by reason', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van 2' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Windowed run', assetId: asset.body.id }).expect(201);
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // window already elapsed -> any completion now is "late"
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // window still open -> "on time"
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        stops: [
          { label: 'On-time delivery', windowEnd: future },
          { label: 'Late delivery', windowEnd: past },
          { label: 'No window at all' },
          { label: 'Failed with reason' },
        ],
      })
      .expect(201);
    const full = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [onTimeStop, lateStop, noWindowStop, failStop] = full.body.stops;

    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${onTimeStop.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${lateStop.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${noWindowStop.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${failStop.id}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'FAILED', failureReason: 'BUSINESS_CLOSED' }).expect(201);

    const report = await request(app.getHttpServer()).get('/v1/reports/operations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(report.body.deliveries.onTime.assessed).toBe(2); // only the two with a window count
    expect(report.body.deliveries.onTime.onTimeCount).toBe(1);
    expect(report.body.deliveries.onTime.lateCount).toBe(1);
    expect(report.body.deliveries.onTime.onTimeRatePct).toBe(50);
    const businessClosed = report.body.failureReasons.find((r: { reason: string }) => r.reason === 'BUSINESS_CLOSED');
    expect(businessClosed.count).toBeGreaterThanOrEqual(1);
  });

  it('sums maintenance job costs closed in the window into a total and a per-day trend', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Cost Truck' }).expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, title: 'Alternator replacement' })
      .expect(201);
    const closed = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/close`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partsCost: 150, laborCost: 50 })
      .expect(201);
    const today = new Date(closed.body.completedAt).toISOString().slice(0, 10);

    const report = await request(app.getHttpServer()).get('/v1/reports/operations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(report.body.cost.totalCost).toBe(200);
    expect(report.body.cost.jobsWithCost).toBe(1);
    expect(report.body.cost.averageCostPerJob).toBe(200);
    const todayBucket = report.body.cost.trend.find((t: { date: string }) => t.date === today);
    expect(todayBucket.cost).toBe(200);
  });

  it('excludes the asset from downtime and keeps 100% uptime when it has no critical fault', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Always Up Truck' }).expect(201);

    const report = await request(app.getHttpServer()).get('/v1/reports/operations').set('Authorization', `Bearer ${token}`).expect(200);
    expect(report.body.uptime.totalAssets).toBe(1);
    expect(report.body.uptime.fleetUptimePct).toBe(100);
    expect(report.body.uptime.assetsWithDowntime).toHaveLength(0);
  });

  it('computes downtime and a reduced uptime% for an asset with an open critical fault backdated into the window', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Down Truck' }).expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, title: 'Engine seized' })
      .expect(201);

    // Backdate to 3 days ago so the open fault covers a meaningful slice of
    // the default 7-day report window — the API has no time-travel endpoint,
    // and DB timestamps can't otherwise be pushed into the past.
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await ownerPrisma.maintenanceJob.update({ where: { id: job.body.id }, data: { createdAt: threeDaysAgo } });

    const report = await request(app.getHttpServer()).get('/v1/reports/operations').set('Authorization', `Bearer ${token}`).expect(200);
    const downEntry = report.body.uptime.assetsWithDowntime.find((a: { assetId: string }) => a.assetId === asset.body.id);
    expect(downEntry).toBeDefined();
    expect(downEntry.uptimePct).toBeLessThan(100);
    expect(downEntry.uptimePct).toBeGreaterThanOrEqual(0);
    expect(downEntry.downtimeHours).toBeGreaterThan(0);
    expect(report.body.uptime.fleetUptimePct).toBeLessThan(100);
  });

  it('requires reports:view', async () => {
    const noPerm = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const token = await login(noPerm.username);
    const res = await request(app.getHttpServer()).get('/v1/reports/operations').set('Authorization', `Bearer ${token}`).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.REPORTS_VIEW);
  });
});
