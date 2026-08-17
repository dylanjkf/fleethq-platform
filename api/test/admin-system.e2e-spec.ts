/**
 * Phase 5c (21-Admin-Platform/Overview.md): real system/infrastructure
 * diagnostics for FleetHQ staff — DB reachability on both runtime roles,
 * process uptime, and version info. No fabricated metrics.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { ensurePermissions, disconnectFixtures } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin System Health', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.SYSTEM_VIEW]);
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

  it('rejects a request without a token', async () => {
    await request(app.getHttpServer()).get('/v1/admin/system/health').expect(401);
  });

  it('rejects a request from an admin without system:view', async () => {
    const other = await createTestAdmin([]);
    const otherLoginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: other.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    await request(app.getHttpServer())
      .get('/v1/admin/system/health')
      .set('Authorization', `Bearer ${otherLoginRes.body.accessToken}`)
      .expect(403);
  });

  it('reports real DB connectivity, process, and version info', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/system/health').set('Authorization', `Bearer ${adminToken}`).expect(200);

    expect(res.body.database.customerApiConnected).toBe(true);
    expect(res.body.database.adminPlatformConnected).toBe(true);
    expect(typeof res.body.process.uptimeSeconds).toBe('number');
    expect(res.body.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.process.nodeVersion).toBe('string');
    expect(res.body.version.apiVersion).toBe('0.1.0');
    expect(res.body.checkedAt).toBeDefined();
  });

  it('reports scheduler + observability panels backed by real data with honest gaps (B4)', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/system/health').set('Authorization', `Bearer ${adminToken}`).expect(200);

    // Scheduler panel: real leases (may be empty in test), coarse-by-design.
    expect(typeof res.body.scheduler.enabled).toBe('boolean');
    expect(res.body.scheduler.granularity).toBe('last_claimed'); // no per-run outcome persisted
    expect(Array.isArray(res.body.scheduler.tasks)).toBe(true);

    // Observability panels are surfaced HONESTLY — status + reason, never a
    // fabricated 5xx-rate or bounce number. Both real data sources are absent
    // in this deployment, so the flags say so rather than mocking a value.
    expect(res.body.observability.errorTracking.summaryAvailable).toBe(false);
    expect(typeof res.body.observability.errorTracking.note).toBe('string');
    expect(res.body.observability.emailDelivery.failureLogAvailable).toBe(false);
    expect(typeof res.body.observability.emailDelivery.note).toBe('string');
  });
});
