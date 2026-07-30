/**
 * Analytics controls (analytics:manage): a company sets its own target
 * percentages + colour thresholds, manually overrides a live dashboard figure
 * (transparently, with an audit trail), excludes an unrepresentative day from
 * the trend, and resets accumulated history. Reads are open to any dashboard
 * viewer (assets:view); every mutation needs analytics:manage.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { DashboardMetricsService } from '../src/dashboard-layouts/dashboard-metrics.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Analytics controls', () => {
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

  it('sets targets/thresholds/overrides and resets them; excludes a day; clears history', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ANALYTICS_MANAGE, PERMISSIONS.ASSETS_VIEW]);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    // Defaults until set.
    const initial = await request(app.getHttpServer()).get('/v1/analytics/settings').set(auth).expect(200);
    expect(initial.body.settings).toMatchObject({ utilisationTarget: 80, complianceTarget: 95, goodThreshold: 95, warnThreshold: 80, isDefault: true });
    expect(initial.body.overrides).toEqual({});

    // Set targets.
    const updated = await request(app.getHttpServer()).put('/v1/analytics/settings').set(auth).send({ utilisationTarget: 70, warnThreshold: 60 }).expect(200);
    expect(updated.body.settings).toMatchObject({ utilisationTarget: 70, warnThreshold: 60, isDefault: false });

    // Amber above green is rejected.
    await request(app.getHttpServer()).put('/v1/analytics/settings').set(auth).send({ goodThreshold: 50, warnThreshold: 90 }).expect(400);

    // Override the utilisation figure, then read it back with attribution.
    const overridden = await request(app.getHttpServer()).put('/v1/analytics/overrides/utilisation').set(auth).send({ value: 42, note: 'Excluding the depot move week' }).expect(200);
    expect(overridden.body.overrides.utilisation).toMatchObject({ value: 42, note: 'Excluding the depot move week' });

    // Unknown metric rejected.
    await request(app.getHttpServer()).put('/v1/analytics/overrides/nonsense').set(auth).send({ value: 10 }).expect(400);

    // Clear the override.
    const cleared = await request(app.getHttpServer()).delete('/v1/analytics/overrides/utilisation').set(auth).expect(200);
    expect(cleared.body.overrides).toEqual({});

    // Reset settings back to defaults.
    const reset = await request(app.getHttpServer()).post('/v1/analytics/settings/reset').set(auth).expect(201);
    expect(reset.body.settings.isDefault).toBe(true);

    // Seed a snapshot for today, then exclude it → the trend drops it.
    const metricsSvc = app.get(DashboardMetricsService);
    await metricsSvc.recordSnapshot(tenant.companyId);
    const today = new Date().toISOString().slice(0, 10);
    const snapshots = await request(app.getHttpServer()).get('/v1/analytics/snapshots').set(auth).expect(200);
    expect(snapshots.body.items.some((s: { date: string }) => s.date === today)).toBe(true);

    await request(app.getHttpServer()).post(`/v1/analytics/snapshots/${today}/exclusion`).set(auth).send({ excluded: true }).expect(201);
    const trend = await request(app.getHttpServer()).get('/v1/dashboard/utilisation-trend').set(auth).expect(200);
    expect(trend.body.points.some((p: { date: string }) => p.date === today)).toBe(false);

    // Reset history clears the snapshots.
    const cleaned = await request(app.getHttpServer()).post('/v1/analytics/history/reset').set(auth).expect(201);
    expect(cleaned.body.deleted).toBeGreaterThanOrEqual(1);
    const emptyTrend = await request(app.getHttpServer()).get('/v1/dashboard/utilisation-trend').set(auth).expect(200);
    expect(emptyTrend.body.points).toEqual([]);
  });

  it('lets a dashboard viewer read settings but not change them', async () => {
    const viewer = await createTestTenant([PERMISSIONS.ASSETS_VIEW]);
    const token = await login(viewer.username);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app.getHttpServer()).get('/v1/analytics/settings').set(auth).expect(200);
    const denied = await request(app.getHttpServer()).put('/v1/analytics/settings').set(auth).send({ utilisationTarget: 50 }).expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.ANALYTICS_MANAGE);
    await request(app.getHttpServer()).post('/v1/analytics/history/reset').set(auth).expect(403);
  });

  it('writes an audit line when an override is set', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ANALYTICS_MANAGE, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.AUDIT_VIEW]);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    await request(app.getHttpServer()).put('/v1/analytics/overrides/prestart').set(auth).send({ value: 88, note: 'corrected' }).expect(200);
    const audit = await request(app.getHttpServer()).get('/v1/audit-logs').set(auth).expect(200);
    expect(audit.body.items.some((e: { action: string }) => e.action === 'analytics.override_set')).toBe(true);
  });
});
