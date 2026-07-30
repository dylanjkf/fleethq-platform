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

describe('User management', () => {
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

  async function createRole(token: string, name: string, permissionKeys: string[]) {
    const res = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, permissionKeys })
      .expect(201);
    return res.body.id as string;
  }

  it('invites a user, lists them, changes their role, then deactivates them', async () => {
    const token = await loginAsFullyPermissionedAdmin();
    const roleAId = await createRole(token, 'Dispatcher', [PERMISSIONS.OPERATORS_VIEW]);
    const roleBId = await createRole(token, 'Senior Dispatcher', [
      PERMISSIONS.OPERATORS_VIEW,
      PERMISSIONS.OPERATORS_EDIT,
    ]);

    const created = await request(app.getHttpServer())
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        username: `dispatcher-${roleAId}`,
        password: 'a-strong-password',
        fullName: 'Dana Dispatcher',
        roleId: roleAId,
      })
      .expect(201);
    expect(created.body.role.id).toBe(roleAId);
    expect(created.body.archivedAt).toBeNull();

    const list = await request(app.getHttpServer())
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items.some((u: { id: string }) => u.id === created.body.id)).toBe(true);

    const updated = await request(app.getHttpServer())
      .patch(`/v1/users/${created.body.id}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ roleId: roleBId })
      .expect(200);
    expect(updated.body.role.id).toBe(roleBId);

    const deactivated = await request(app.getHttpServer())
      .post(`/v1/users/${created.body.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(deactivated.body.archivedAt).not.toBeNull();

    const listAfter = await request(app.getHttpServer())
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listAfter.body.items.some((u: { id: string }) => u.id === created.body.id)).toBe(false);
  });

  it('rejects creating a user with a username that is already taken', async () => {
    const token = await loginAsFullyPermissionedAdmin();
    const roleId = await createRole(token, 'Role A', []);
    const body = {
      username: `dup-user-${roleId}`,
      password: 'a-strong-password',
      fullName: 'Dup',
      roleId,
    };
    await request(app.getHttpServer())
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
    expect(res.body.error.code).toBe('USERNAME_TAKEN');
  });

  it("does not let one company see or manage another company's users", async () => {
    const tokenA = await loginAsFullyPermissionedAdmin();
    const tokenB = await loginAsFullyPermissionedAdmin();

    const roleBId = await createRole(tokenB, 'Role B', []);
    const userB = await request(app.getHttpServer())
      .post('/v1/users')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ username: `userb-${roleBId}`, password: 'a-strong-password', fullName: 'User B', roleId: roleBId })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/v1/users/${userB.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    // Also can't be used as a role assignment target from another tenant.
    const roleAId = await createRole(tokenA, 'Role A2', []);
    await request(app.getHttpServer())
      .patch(`/v1/users/${userB.body.id}/role`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ roleId: roleAId })
      .expect(404);
  });

  describe('linking an existing user to a second company', () => {
    it('grants an existing user (created in company A) access to company B', async () => {
      const tokenA = await loginAsFullyPermissionedAdmin();
      const tokenB = await loginAsFullyPermissionedAdmin();
      const roleAId = await createRole(tokenA, 'Contractor Role A', [PERMISSIONS.OPERATORS_VIEW]);

      const contractorUsername = `contractor-${roleAId}`;
      await request(app.getHttpServer())
        .post('/v1/users')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          username: contractorUsername,
          password: 'a-strong-password',
          fullName: 'Contractor Chris',
          roleId: roleAId,
        })
        .expect(201);

      const roleBId = await createRole(tokenB, 'Contractor Role B', [PERMISSIONS.ASSETS_VIEW]);
      const linked = await request(app.getHttpServer())
        .post('/v1/users/link')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username: contractorUsername, roleId: roleBId })
        .expect(201);
      expect(linked.body.username).toBe(contractorUsername);
      expect(linked.body.role.id).toBe(roleBId);
      expect(linked.body.archivedAt).toBeNull();

      // The same login now has access to both companies with different roles.
      const login = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ username: contractorUsername, password: 'a-strong-password' })
        .expect(200);
      expect(login.body.status).toBe('choose_company');
      expect(login.body.companies).toHaveLength(2);
    });

    it('rejects linking a username that does not exist', async () => {
      const tokenB = await loginAsFullyPermissionedAdmin();
      const roleBId = await createRole(tokenB, 'Role B for missing user', []);
      const res = await request(app.getHttpServer())
        .post('/v1/users/link')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username: 'no-such-username-at-all', roleId: roleBId })
        .expect(404);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('rejects linking a user who already has active access to this company', async () => {
      const tokenB = await loginAsFullyPermissionedAdmin();
      const roleBId = await createRole(tokenB, 'Role B for dup link', []);
      const username = `already-member-${roleBId}`;
      await request(app.getHttpServer())
        .post('/v1/users')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username, password: 'a-strong-password', fullName: 'Already Member', roleId: roleBId })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/v1/users/link')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username, roleId: roleBId })
        .expect(409);
      expect(res.body.error.code).toBe('ALREADY_MEMBER');
    });

    it('reactivates a previously-deactivated membership rather than erroring', async () => {
      const tokenB = await loginAsFullyPermissionedAdmin();
      const roleB1Id = await createRole(tokenB, 'Reactivate Role 1', []);
      const roleB2Id = await createRole(tokenB, 'Reactivate Role 2', [PERMISSIONS.OPERATORS_VIEW]);
      const username = `reactivate-${roleB1Id}`;

      const created = await request(app.getHttpServer())
        .post('/v1/users')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username, password: 'a-strong-password', fullName: 'Reactivate Me', roleId: roleB1Id })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/v1/users/${created.body.id}/deactivate`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(201);

      const relinked = await request(app.getHttpServer())
        .post('/v1/users/link')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ username, roleId: roleB2Id })
        .expect(201);
      expect(relinked.body.archivedAt).toBeNull();
      expect(relinked.body.role.id).toBe(roleB2Id);
    });
  });
});
