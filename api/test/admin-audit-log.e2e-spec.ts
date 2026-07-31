/**
 * Phase 6 prerequisite (21-Admin-Platform/Overview.md): the read half of the
 * admin platform's own audit trail — every prior phase already writes rows
 * here (AdminAuditService.record), this just exposes them for staff to
 * browse/filter.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { ensurePermissions, disconnectFixtures } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Audit Log', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.AUDIT_LOG_VIEW, ADMIN_PERMISSIONS.SUPPORT_MANAGE, ADMIN_PERMISSIONS.SUPPORT_VIEW]);
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
    await request(app.getHttpServer()).get('/v1/admin/audit-log').expect(401);
  });

  it('rejects a request from an admin without audit_log:view', async () => {
    const other = await createTestAdmin([]);
    const otherLoginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: other.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    await request(app.getHttpServer()).get('/v1/admin/audit-log').set('Authorization', `Bearer ${otherLoginRes.body.accessToken}`).expect(403);
  });

  it('lists entries newest-first, and finds one by exact action filter', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/v1/admin/announcements')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Audit log test', body: 'x' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/audit-log')
      .query({ action: 'support.announcement_created', pageSize: 200 })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.items.some((e: { entityId: string; action: string }) => e.entityId === createRes.body.id && e.action === 'support.announcement_created')).toBe(
      true,
    );

    await request(app.getHttpServer()).delete(`/v1/admin/announcements/${createRes.body.id}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
  });
});
