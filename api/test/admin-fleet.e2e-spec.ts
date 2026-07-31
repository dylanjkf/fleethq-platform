/**
 * Phase 5d (21-Admin-Platform/Overview.md): cross-tenant fleet browsing for
 * FleetHQ support staff — "which organisation owns this asset/VIN/rego" or
 * "which company is this integration configured for", without an admin
 * needing to already know the companyId.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Fleet', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    await ensureAssetClasses();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.FLEET_VIEW]);
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

  async function customerLogin(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('rejects an admin route request without a token', async () => {
    await request(app.getHttpServer()).get('/v1/admin/fleet/assets').expect(401);
  });

  it('finds an asset across tenants by VIN, with the owning organisation attached', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE]);
    const token = await customerLogin(tenant.username);
    const vin = `VIN${randomUUID().slice(0, 8).toUpperCase()}`;

    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck A1', vin }).expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/fleet/assets')
      .query({ search: vin })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].vin).toBe(vin);
    expect(res.body.items[0].company.id).toBe(tenant.companyId);
  });

  it('finds an operator across tenants by name', async () => {
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_CREATE]);
    const token = await customerLogin(tenant.username);
    const uniqueName = `Operator ${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: uniqueName }).expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/fleet/operators')
      .query({ search: uniqueName })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].fullName).toBe(uniqueName);
    expect(res.body.items[0]).not.toHaveProperty('lastLat');
  });

  it('finds an integration connection across tenants, without ever exposing credentials', async () => {
    const tenant = await createTestTenant([PERMISSIONS.INTEGRATIONS_MANAGE]);
    const token = await customerLogin(tenant.username);
    const uniqueName = `Connector ${randomUUID().slice(0, 8)}`;

    await request(app.getHttpServer())
      .post('/v1/integrations/connections')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: uniqueName, connectorType: 'REST', direction: 'IMPORT', targetEntity: 'assets', config: { url: 'https://example.com' } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/admin/fleet/integrations')
      .query({ search: uniqueName })
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe(uniqueName);
    expect(res.body.items[0].company.id).toBe(tenant.companyId);
    expect(res.body.items[0]).not.toHaveProperty('config');
    expect(res.body.items[0]).not.toHaveProperty('credentialId');
  });

  it('rejects a fleet-view request from an admin without the permission', async () => {
    const other = await createTestAdmin([]);
    const otherLoginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: other.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    await request(app.getHttpServer())
      .get('/v1/admin/fleet/assets')
      .set('Authorization', `Bearer ${otherLoginRes.body.accessToken}`)
      .expect(403);
  });
});
