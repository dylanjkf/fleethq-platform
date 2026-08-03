/**
 * Admin-users management console (`admin_users:view` / `admin_users:manage`) —
 * onboarding/offboarding FleetHQ's own staff accounts — plus the Round 3
 * post-login obligations gate: forced password reset and forced MFA enrollment
 * (`AdminPermissionGuard` + `POST /v1/admin/auth/change-password`). The module
 * had unit coverage only before this spec (Round 3 Low).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { ensurePermissions } from './utils/fixtures';
import {
  createTestAdmin,
  disconnectAdminFixtures,
  ensureAdminPermissions,
  TEST_ADMIN_PASSWORD,
} from './utils/admin-fixtures';

describe('Admin Users management', () => {
  let app: INestApplication;
  let manageToken: string;
  let viewOnlyToken: string;
  let supportRoleId: string;

  function login(username: string, password = TEST_ADMIN_PASSWORD) {
    return request(app.getHttpServer()).post('/v1/admin/auth/login').send({ username, password });
  }

  beforeAll(async () => {
    await ensurePermissions();
    await ensureAdminPermissions();
    app = await buildTestApp();

    const manageAdmin = await createTestAdmin([ADMIN_PERMISSIONS.ADMIN_USERS_VIEW, ADMIN_PERMISSIONS.ADMIN_USERS_MANAGE]);
    manageToken = (await login(manageAdmin.username).expect(200)).body.accessToken as string;

    const viewAdmin = await createTestAdmin([ADMIN_PERMISSIONS.ADMIN_USERS_VIEW]);
    viewOnlyToken = (await login(viewAdmin.username).expect(200)).body.accessToken as string;

    // Any role is a valid assignment target; reuse the view-only admin's role.
    const rolesRes = await request(app.getHttpServer())
      .get('/v1/admin/users/roles')
      .set('Authorization', `Bearer ${manageToken}`)
      .expect(200);
    supportRoleId = rolesRes.body[0].id as string;
  });

  afterAll(async () => {
    await app.close();
    await disconnectAdminFixtures();
  });

  it('rejects unauthenticated access', async () => {
    await request(app.getHttpServer()).get('/v1/admin/users').expect(401);
  });

  it('rejects create from a view-only admin (403)', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${viewOnlyToken}`)
      .send({ username: 'nope', email: 'nope@fleethq.internal', fullName: 'No', password: 'Str0ng-Pass!', roleId: supportRoleId })
      .expect(403);
  });

  it('creates, lists, fetches, changes role, deactivates, and reactivates a staff account', async () => {
    const suffix = Date.now();
    const username = `staff-${suffix}`;
    const createRes = await request(app.getHttpServer())
      .post('/v1/admin/users')
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ username, email: `${username}@fleethq.internal`, fullName: 'New Staff', password: 'Str0ng-Pass!', roleId: supportRoleId })
      .expect(201);
    const id = createRes.body.id as string;
    expect(createRes.body).not.toHaveProperty('passwordHash');

    const listRes = await request(app.getHttpServer())
      .get('/v1/admin/users')
      .set('Authorization', `Bearer ${manageToken}`)
      .expect(200);
    expect(listRes.body.items.some((u: { id: string }) => u.id === id)).toBe(true);

    await request(app.getHttpServer()).get(`/v1/admin/users/${id}`).set('Authorization', `Bearer ${manageToken}`).expect(200);

    await request(app.getHttpServer())
      .patch(`/v1/admin/users/${id}/role`)
      .set('Authorization', `Bearer ${manageToken}`)
      .send({ roleId: supportRoleId })
      .expect(200);

    await request(app.getHttpServer()).post(`/v1/admin/users/${id}/deactivate`).set('Authorization', `Bearer ${manageToken}`).expect(200);
    await request(app.getHttpServer()).post(`/v1/admin/users/${id}/reactivate`).set('Authorization', `Bearer ${manageToken}`).expect(200);
  });

  it('400s on a malformed :id (ParseUUIDPipe)', async () => {
    await request(app.getHttpServer()).get('/v1/admin/users/not-a-uuid').set('Authorization', `Bearer ${manageToken}`).expect(400);
  });

  describe('Post-login obligations gate (Round 3 H1/H3)', () => {
    it('blocks a mustResetPassword admin from normal routes, but lets them change their password and then through', async () => {
      const admin = await createTestAdmin([ADMIN_PERMISSIONS.ANALYTICS_VIEW], { mustResetPassword: true });
      const token = (await login(admin.username).expect(200)).body.accessToken as string;

      // A permission-gated route is blocked with ADMIN_SETUP_REQUIRED...
      const blocked = await request(app.getHttpServer())
        .get('/v1/admin/analytics/overview')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(blocked.body.error?.code ?? blocked.body.code).toBe('ADMIN_SETUP_REQUIRED');

      // ...but /me stays reachable and reports the obligation.
      const me = await request(app.getHttpServer()).get('/v1/admin/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(me.body.obligations.passwordReset).toBe(true);

      // Change the password → obligation clears, a fresh token is returned.
      const changed = await request(app.getHttpServer())
        .post('/v1/admin/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: 'An0ther-Str0ng!' })
        .expect(200);
      const newToken = changed.body.accessToken as string;
      expect(typeof newToken).toBe('string');

      // Now the previously-blocked route is reachable.
      await request(app.getHttpServer()).get('/v1/admin/analytics/overview').set('Authorization', `Bearer ${newToken}`).expect(200);

      // And the old temporary password no longer authenticates.
      await login(admin.username, TEST_ADMIN_PASSWORD).expect(401);
    });

    it('rejects a change-password with the wrong current password', async () => {
      const admin = await createTestAdmin([ADMIN_PERMISSIONS.ANALYTICS_VIEW], { mustResetPassword: true });
      const token = (await login(admin.username).expect(200)).body.accessToken as string;
      await request(app.getHttpServer())
        .post('/v1/admin/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'wrong-password', newPassword: 'An0ther-Str0ng!' })
        .expect(401);
    });
  });
});
