/**
 * DriverOS v0 milestone: Operator-to-User login linking
 * (04-DriverOS/DriverOS_Overview.md), the derived `operator` field on
 * GET /v1/auth/me, and the `operatorId` filter on GET /v1/jobs that DriverOS's
 * "Today" screen depends on.
 */
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

describe('DriverOS v0 (Operator login link)', () => {
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

  async function loginAndGetToken(username: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function createDriverRole(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/roles')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: `Driver ${Date.now()}`,
        permissionKeys: [PERMISSIONS.DISPATCH_VIEW, PERMISSIONS.MAINTENANCE_CREATE],
      })
      .expect(201);
    return res.body.id as string;
  }

  const ADMIN_PERMS = [
    PERMISSIONS.OPERATORS_CREATE,
    PERMISSIONS.OPERATORS_VIEW,
    PERMISSIONS.USERS_CREATE,
    PERMISSIONS.ROLES_CREATE,
    PERMISSIONS.ASSETS_CREATE,
    PERMISSIONS.DISPATCH_CREATE,
    PERMISSIONS.DISPATCH_VIEW,
    PERMISSIONS.DISPATCH_ASSIGN,
  ];

  it('links a new User login to an Operator, and that login can authenticate', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const adminToken = await loginAndGetToken(tenant.username);

    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Dana Driver' })
      .expect(201);

    const roleId = await createDriverRole(adminToken);
    const driverUsername = `dana-${Date.now()}`;

    const linked = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/link-user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: driverUsername, password: 'Driver-Password-123', roleId })
      .expect(201);
    expect(linked.body.userId).toEqual(expect.any(String));

    // The new login works, and reuses the Operator's own fullName — never
    // re-typed (dto had no fullName field at all).
    const driverLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: driverUsername, password: 'Driver-Password-123' })
      .expect(200);
    expect(driverLogin.body.status).toBe('authenticated');

    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${driverLogin.body.accessToken}`)
      .expect(200);
    expect(me.body.fullName).toBe('Dana Driver');
    expect(me.body.operator).toMatchObject({ id: operator.body.id, fullName: 'Dana Driver' });
  });

  it('reports operator: null on auth/me for a normal FleetHQ-only user', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const token = await loginAndGetToken(tenant.username);

    const me = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.operator).toBeNull();
  });

  it('rejects linking an operator that already has a login', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const adminToken = await loginAndGetToken(tenant.username);

    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullName: 'Already Linked' })
      .expect(201);
    const roleId = await createDriverRole(adminToken);

    await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/link-user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: `first-${Date.now()}`, password: 'Driver-Password-123', roleId })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/link-user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: `second-${Date.now()}`, password: 'Driver-Password-123', roleId })
      .expect(409);
    expect(second.body.error.code).toBe('OPERATOR_ALREADY_LINKED');
  });

  it('rejects link-user without users:create', async () => {
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_CREATE, PERMISSIONS.ROLES_CREATE]);
    const token = await loginAndGetToken(tenant.username);

    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'No Perms' })
      .expect(201);
    const roleId = await createDriverRole(token);

    const res = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/link-user`)
      .set('Authorization', `Bearer ${token}`)
      .send({ username: `noperm-${Date.now()}`, password: 'Driver-Password-123', roleId })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.USERS_CREATE);
  });

  it('filters GET /v1/jobs by operatorId, the way DriverOS Today does', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Truck' })
      .expect(201);
    const operatorA = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Operator A' })
      .expect(201);
    const operatorB = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Operator B' })
      .expect(201);

    const jobA = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: "Operator A's run", assetId: asset.body.id, operatorId: operatorA.body.id })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: "Operator B's run", assetId: asset.body.id, operatorId: operatorB.body.id })
      .expect(201);

    const filtered = await request(app.getHttpServer())
      .get(`/v1/jobs?operatorId=${operatorA.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].id).toBe(jobA.body.id);

    const filteredByStatus = await request(app.getHttpServer())
      .get(`/v1/jobs?operatorId=${operatorA.body.id}&status=ASSIGNED`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(filteredByStatus.body.items).toHaveLength(1);
  });
});
