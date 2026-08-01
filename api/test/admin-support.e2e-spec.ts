/**
 * Phase 5a (21-Admin-Platform/Overview.md): support tools — a customer-visible
 * announcement banner, staff-internal organisation notes, and a "resend
 * verification email" support action.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Support', () => {
  let app: INestApplication;
  let adminToken: string;
  let viewOnlyToken: string;
  let companyId: string;
  let username: string;

  beforeAll(async () => {
    await ensurePermissions();
    app = await buildTestApp();

    const admin = await createTestAdmin([
      ADMIN_PERMISSIONS.SUPPORT_VIEW,
      ADMIN_PERMISSIONS.SUPPORT_MANAGE,
      ADMIN_PERMISSIONS.ORGANISATIONS_VIEW,
    ]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = loginRes.body.accessToken as string;

    const viewOnlyAdmin = await createTestAdmin([ADMIN_PERMISSIONS.SUPPORT_VIEW]);
    const viewOnlyLoginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: viewOnlyAdmin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    viewOnlyToken = viewOnlyLoginRes.body.accessToken as string;

    const tenant = await createTestTenant([]);
    companyId = tenant.companyId;
    username = tenant.username;
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  async function customerLogin(): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  describe('Announcements', () => {
    it('rejects an admin route request without a token', async () => {
      await request(app.getHttpServer()).get('/v1/admin/announcements').expect(401);
    });

    it('creates, lists, updates, and deletes an announcement, and it becomes visible to customers only while active', async () => {
      const createRes = await request(app.getHttpServer())
        .post('/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Scheduled maintenance', body: 'The platform will be briefly unavailable.', severity: 'WARNING' })
        .expect(201);
      const announcementId = createRes.body.id as string;
      expect(createRes.body.active).toBe(true);

      const listRes = await request(app.getHttpServer())
        .get('/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(listRes.body.some((a: { id: string }) => a.id === announcementId)).toBe(true);

      const customerToken = await customerLogin();
      const activeRes = await request(app.getHttpServer())
        .get('/v1/announcements/active')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect(activeRes.body.some((a: { id: string }) => a.id === announcementId)).toBe(true);

      await request(app.getHttpServer())
        .patch(`/v1/admin/announcements/${announcementId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ active: false })
        .expect(200);

      const afterDeactivateRes = await request(app.getHttpServer())
        .get('/v1/announcements/active')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect(afterDeactivateRes.body.some((a: { id: string }) => a.id === announcementId)).toBe(false);

      await request(app.getHttpServer())
        .delete(`/v1/admin/announcements/${announcementId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const afterDeleteRes = await request(app.getHttpServer())
        .get('/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterDeleteRes.body.some((a: { id: string }) => a.id === announcementId)).toBe(false);
    });

    it('rejects creating an announcement from a view-only admin', async () => {
      await request(app.getHttpServer())
        .post('/v1/admin/announcements')
        .set('Authorization', `Bearer ${viewOnlyToken}`)
        .send({ title: 'x', body: 'y' })
        .expect(403);
    });

    it('does not show an announcement whose window has not started yet', async () => {
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const createRes = await request(app.getHttpServer())
        .post('/v1/admin/announcements')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Future notice', body: 'Not yet.', startsAt: future })
        .expect(201);

      const customerToken = await customerLogin();
      const activeRes = await request(app.getHttpServer())
        .get('/v1/announcements/active')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      expect(activeRes.body.some((a: { id: string }) => a.id === createRes.body.id)).toBe(false);

      await request(app.getHttpServer())
        .delete(`/v1/admin/announcements/${createRes.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });
  });

  describe('Organisation notes', () => {
    it('adds, lists, and deletes an internal note, scoped to the organisation', async () => {
      const addRes = await request(app.getHttpServer())
        .post(`/v1/admin/organisations/${companyId}/notes`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ body: 'Called customer re: overdue invoice.' })
        .expect(201);
      const noteId = addRes.body.id as string;

      const listRes = await request(app.getHttpServer())
        .get(`/v1/admin/organisations/${companyId}/notes`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(listRes.body.some((n: { id: string }) => n.id === noteId)).toBe(true);

      await request(app.getHttpServer())
        .delete(`/v1/admin/organisations/${companyId}/notes/${noteId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const afterDeleteRes = await request(app.getHttpServer())
        .get(`/v1/admin/organisations/${companyId}/notes`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(afterDeleteRes.body.some((n: { id: string }) => n.id === noteId)).toBe(false);
    });

    it('rejects adding a note from a view-only admin', async () => {
      await request(app.getHttpServer())
        .post(`/v1/admin/organisations/${companyId}/notes`)
        .set('Authorization', `Bearer ${viewOnlyToken}`)
        .send({ body: 'x' })
        .expect(403);
    });

    it('404s for a non-existent organisation', async () => {
      await request(app.getHttpServer())
        .get('/v1/admin/organisations/00000000-0000-0000-0000-000000000000/notes')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('Resend verification', () => {
    it('resends a verification email to a customer user (support:manage)', async () => {
      const userRes = await request(app.getHttpServer())
        .get(`/v1/admin/organisations/${companyId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const userId = userRes.body.users[0].userId as string;

      const res = await request(app.getHttpServer())
        .post(`/v1/admin/customer-users/${userId}/resend-verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(typeof res.body.emailOnFile).toBe('boolean');
    });
  });
});
