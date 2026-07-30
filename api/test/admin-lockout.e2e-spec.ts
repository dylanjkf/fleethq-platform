/**
 * apps/api/README.md's "Known gaps" (now closed): nothing stopped a user
 * removing their own last administrative permission, changing their own
 * role away from one that could manage roles/users, or editing the only
 * such role's permission set — each of these used to leave a company with
 * no way to recover short of direct DB access. AdminLockoutGuardService
 * (src/common/admin-lockout) rejects any of the three when no other active
 * membership would still hold both roles:edit and users:edit afterward.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  addUserToCompany,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

describe('Admin lockout guard', () => {
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
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function findMembershipId(token: string, username: string): Promise<string> {
    const list = await request(app.getHttpServer()).get('/v1/users').set('Authorization', `Bearer ${token}`).expect(200);
    return list.body.items.find((u: { username: string }) => u.username === username).id;
  }

  const ADMIN_PERMISSIONS = [
    PERMISSIONS.ROLES_EDIT,
    PERMISSIONS.ROLES_CREATE,
    PERMISSIONS.USERS_EDIT,
    PERMISSIONS.ROLES_VIEW,
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.USERS_ARCHIVE,
  ];

  it('blocks the sole admin from deactivating their own membership', async () => {
    const admin = await createTestTenant(ADMIN_PERMISSIONS);
    const token = await login(admin.username);
    const ownMembershipId = await findMembershipId(token, admin.username);

    const res = await request(app.getHttpServer())
      .post(`/v1/users/${ownMembershipId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.code).toBe('ADMIN_LOCKOUT');
  });

  it('blocks the sole admin from changing their own role to one without admin permissions', async () => {
    const admin = await createTestTenant(ADMIN_PERMISSIONS);
    const token = await login(admin.username);
    const ownMembershipId = await findMembershipId(token, admin.username);

    const nonAdminRole = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No Admin Rights', permissionKeys: [PERMISSIONS.ASSETS_VIEW] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .patch(`/v1/users/${ownMembershipId}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: nonAdminRole.body.id })
      .expect(403);
    expect(res.body.error.code).toBe('ADMIN_LOCKOUT');
  });

  it('blocks stripping roles:edit/users:edit from the only role that grants it', async () => {
    const admin = await createTestTenant(ADMIN_PERMISSIONS);
    const token = await login(admin.username);

    const roles = await request(app.getHttpServer()).get('/v1/roles').set('Authorization', `Bearer ${token}`).expect(200);
    const ownRoleId = roles.body.items[0].id;

    const res = await request(app.getHttpServer())
      .patch(`/v1/roles/${ownRoleId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ permissionKeys: [PERMISSIONS.ASSETS_VIEW] })
      .expect(403);
    expect(res.body.error.code).toBe('ADMIN_LOCKOUT');
  });

  it('allows deactivating or demoting an admin once a second admin exists', async () => {
    const admin = await createTestTenant(ADMIN_PERMISSIONS);
    const token = await login(admin.username);
    const ownMembershipId = await findMembershipId(token, admin.username);

    await addUserToCompany(admin.companyId, ADMIN_PERMISSIONS, 'Second Admin');

    await request(app.getHttpServer())
      .post(`/v1/users/${ownMembershipId}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
  });
});
