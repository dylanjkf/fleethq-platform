/**
 * 01-Product/Onboarding_Decommissioning.md: archiving an Operator must also
 * revoke any DriverOS login linked to it — otherwise a "decommissioned"
 * operator profile is cosmetic while the same person can still sign in.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ADMIN_PERMS = [
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.OPERATORS_VIEW,
  PERMISSIONS.OPERATORS_ARCHIVE,
  PERMISSIONS.USERS_CREATE,
  PERMISSIONS.USERS_VIEW,
  PERMISSIONS.ROLES_CREATE,
];

describe('Operator decommissioning revokes a linked DriverOS login', () => {
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

  it("deactivates the operator's linked CompanyMembership when the operator is archived", async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const adminToken = await login(tenant.username);

    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Dana Driver' })
      .expect(201);

    const role = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Driver ${Date.now()}`, permissionKeys: [] })
      .expect(201);

    const driverUsername = `dana-${Date.now()}`;
    await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/link-user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: driverUsername, password: 'driver-password-123', roleId: role.body.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    const users = await request(app.getHttpServer()).get('/v1/users').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(users.body.items.some((u: { username: string }) => u.username === driverUsername)).toBe(false);

    const usersWithArchived = await request(app.getHttpServer())
      .get('/v1/users?includeArchived=true')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const driverMembership = usersWithArchived.body.items.find((u: { username: string }) => u.username === driverUsername);
    expect(driverMembership.archivedAt).not.toBeNull();
  });

  it('archiving an operator with no linked login is unaffected (no-op)', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const adminToken = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Solo Operator' })
      .expect(201);

    const archived = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/archive`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect(archived.body.archivedAt).not.toBeNull();
  });
});
