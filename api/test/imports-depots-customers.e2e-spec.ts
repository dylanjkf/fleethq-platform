/**
 * Bulk import extended to Depots and Customers (01-Product/Onboarding_Import.md)
 * — same dry-run/commit shape as the existing Assets/Operators import, reusing
 * DepotsService/CustomersService.create() per row.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Imports: Depots + Customers', () => {
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

  it('dry-runs then commits a Depots import, skipping only the invalid row', async () => {
    const tenant = await createTestTenant([PERMISSIONS.DEPOTS_CREATE, PERMISSIONS.DEPOTS_VIEW]);
    const token = await login(tenant.username);

    const dryRun = await request(app.getHttpServer())
      .post('/v1/imports/depots')
      .set('Authorization', `Bearer ${token}`)
      .send({ dryRun: true, rows: [{ name: 'Main Depot', address: '1 Smith St' }, { address: 'no name here' }] })
      .expect(201);
    expect(dryRun.body).toMatchObject({ total: 2, validCount: 1, invalidCount: 1, createdCount: 0 });

    const commit = await request(app.getHttpServer())
      .post('/v1/imports/depots')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'Main Depot', address: '1 Smith St' }, { address: 'no name here' }] })
      .expect(201);
    expect(commit.body.createdCount).toBe(1);

    const list = await request(app.getHttpServer()).get('/v1/depots').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.map((d: { name: string }) => d.name)).toContain('Main Depot');
  });

  it('dry-runs then commits a Customers import, skipping only the invalid row', async () => {
    const tenant = await createTestTenant([PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.CUSTOMERS_VIEW]);
    const token = await login(tenant.username);

    const dryRun = await request(app.getHttpServer())
      .post('/v1/imports/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ dryRun: true, rows: [{ name: 'ACME Pty Ltd', address: '1 High St' }, { address: 'no name here' }] })
      .expect(201);
    expect(dryRun.body).toMatchObject({ total: 2, validCount: 1, invalidCount: 1, createdCount: 0 });

    const commit = await request(app.getHttpServer())
      .post('/v1/imports/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'ACME Pty Ltd', address: '1 High St' }, { address: 'no name here' }] })
      .expect(201);
    expect(commit.body.createdCount).toBe(1);

    const list = await request(app.getHttpServer()).get('/v1/customers').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.map((c: { name: string }) => c.name)).toContain('ACME Pty Ltd');
  });

  it('requires depots:create / customers:create respectively', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.DEPOTS_VIEW, PERMISSIONS.CUSTOMERS_VIEW]);
    const token = await login(viewOnly.username);

    const depotsRes = await request(app.getHttpServer())
      .post('/v1/imports/depots')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'X' }] })
      .expect(403);
    expect(depotsRes.body.error.requiredPermission).toBe(PERMISSIONS.DEPOTS_CREATE);

    const customersRes = await request(app.getHttpServer())
      .post('/v1/imports/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'X' }] })
      .expect(403);
    expect(customersRes.body.error.requiredPermission).toBe(PERMISSIONS.CUSTOMERS_CREATE);
  });
});
