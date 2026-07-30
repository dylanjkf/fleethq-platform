import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

describe('Role management', () => {
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

  async function loginAsFullyPermissionedAdmin(): Promise<string> {
    const admin = await createTestTenant(Object.values(PERMISSIONS));
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: admin.username, password: TEST_PASSWORD })
      .expect(200);
    return login.body.accessToken as string;
  }

  it('creates, edits, clones, and archives a role', async () => {
    const token = await loginAsFullyPermissionedAdmin();

    const created = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Workshop Tech', permissionKeys: [PERMISSIONS.ASSETS_VIEW] })
      .expect(201);
    expect(created.body.permissionKeys).toEqual([PERMISSIONS.ASSETS_VIEW]);
    expect(created.body.isSystemTemplate).toBe(false);

    const updated = await request(app.getHttpServer())
      .patch(`/v1/roles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ permissionKeys: [PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_EDIT] })
      .expect(200);
    expect([...updated.body.permissionKeys].sort()).toEqual(
      [PERMISSIONS.ASSETS_EDIT, PERMISSIONS.ASSETS_VIEW].sort(),
    );

    const cloned = await request(app.getHttpServer())
      .post(`/v1/roles/${created.body.id}/clone`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Workshop Tech (copy)' })
      .expect(201);
    expect([...cloned.body.permissionKeys].sort()).toEqual([...updated.body.permissionKeys].sort());
    expect(cloned.body.id).not.toBe(created.body.id);

    // Nobody is assigned to the clone — archiving it should succeed outright.
    await request(app.getHttpServer())
      .post(`/v1/roles/${cloned.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
  });

  it('refuses to archive a role that active users are still assigned to', async () => {
    const token = await loginAsFullyPermissionedAdmin();

    const role = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'In-Use Role', permissionKeys: [] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        username: `assigned-${role.body.id}`,
        password: 'a-strong-password',
        fullName: 'Assigned User',
        roleId: role.body.id,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/v1/roles/${role.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(res.body.error.code).toBe('ROLE_IN_USE');
  });

  it('rejects an unknown permission key at the DTO layer', async () => {
    const token = await loginAsFullyPermissionedAdmin();
    await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Role', permissionKeys: ['not:a-real-permission'] })
      .expect(400);
  });

  it("does not let one company see or archive another company's role", async () => {
    const tokenA = await loginAsFullyPermissionedAdmin();
    const tokenB = await loginAsFullyPermissionedAdmin();

    const roleB = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Role Only B Can See', permissionKeys: [] })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/v1/roles/${roleB.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/v1/roles/${roleB.body.id}/archive`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });
});
