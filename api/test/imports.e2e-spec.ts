/**
 * Import milestone: bulk-input path for Asset/Operator creation
 * (01-Product/Onboarding_Import.md) — dryRun validation, partial-success
 * commit, and reuse of the exact same permissions manual creation uses.
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

describe('Imports (Import milestone)', () => {
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

  it('validates rows without creating anything when dryRun is true', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const token = await loginAndGetToken(tenant.username);

    const res = await request(app.getHttpServer())
      .post('/v1/imports/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        dryRun: true,
        rows: [{ name: 'Truck 1' }, { externalReference: 'no name here' }, { name: 'Truck 2', assetClass: 'AIR' }],
      })
      .expect(201);

    expect(res.body.total).toBe(3);
    expect(res.body.createdCount).toBe(0);
    // Row 2 (assetClass: AIR) is DTO-valid — AIR is a real enum value.
    // Whether it's *implemented* is only checked at creation time, not here.
    expect(res.body.validCount).toBe(2);
    expect(res.body.invalidCount).toBe(1);
    expect(res.body.rows[0]).toMatchObject({ index: 0, valid: true, created: false });
    expect(res.body.rows[1]).toMatchObject({ index: 1, valid: false, created: false });
    expect(res.body.rows[2].valid).toBe(true);

    const list = await request(app.getHttpServer())
      .get('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.total).toBe(0);
  });

  it('commits valid rows and reports invalid ones individually, without blocking the batch', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const token = await loginAndGetToken(tenant.username);

    const res = await request(app.getHttpServer())
      .post('/v1/imports/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rows: [
          { name: 'Truck A', externalReference: 'REG-001' },
          { name: '' },
          { name: 'Truck B' },
          { name: 'Truck C', assetClass: 'NOT_A_REAL_CATEGORY' },
        ],
      })
      .expect(201);

    expect(res.body.total).toBe(4);
    expect(res.body.createdCount).toBe(2);
    expect(res.body.validCount).toBe(2);
    expect(res.body.invalidCount).toBe(2);
    expect(res.body.rows[0]).toMatchObject({ valid: true, created: true });
    expect(res.body.rows[0].id).toEqual(expect.any(String));
    expect(res.body.rows[1]).toMatchObject({ valid: false, created: false });
    expect(res.body.rows[2]).toMatchObject({ valid: true, created: true });
    expect(res.body.rows[3]).toMatchObject({ valid: false, created: false });
    expect(res.body.rows[3].errors[0]).toMatch(/category not found/i);

    const list = await request(app.getHttpServer())
      .get('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.total).toBe(2);
    expect(list.body.items.map((a: { name: string }) => a.name).sort()).toEqual(['Truck A', 'Truck B']);
  });

  it('imports operators the same way, normalizing an invalid email to a per-row error', async () => {
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_CREATE, PERMISSIONS.OPERATORS_VIEW]);
    const token = await loginAndGetToken(tenant.username);

    const res = await request(app.getHttpServer())
      .post('/v1/imports/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rows: [
          { fullName: 'Alice Operator', email: 'alice@example.com' },
          { fullName: 'Bob Operator', email: 'not-an-email' },
        ],
      })
      .expect(201);

    expect(res.body.createdCount).toBe(1);
    expect(res.body.rows[0]).toMatchObject({ valid: true, created: true });
    expect(res.body.rows[1]).toMatchObject({ valid: false, created: false });

    const list = await request(app.getHttpServer())
      .get('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].fullName).toBe('Alice Operator');
  });

  it('is tenant-isolated: rows created by one company are invisible to another', async () => {
    const tenantA = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const tenantB = await createTestTenant([PERMISSIONS.ASSETS_VIEW]);
    const tokenA = await loginAndGetToken(tenantA.username);
    const tokenB = await loginAndGetToken(tenantB.username);

    await request(app.getHttpServer())
      .post('/v1/imports/assets')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ rows: [{ name: 'Company A Only Truck' }] })
      .expect(201);

    const listB = await request(app.getHttpServer())
      .get('/v1/assets')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(listB.body.total).toBe(0);
  });

  it('rejects imports without assets:create / operators:create', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.ASSETS_VIEW]);
    const token = await loginAndGetToken(viewOnly.username);

    const res = await request(app.getHttpServer())
      .post('/v1/imports/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'Should not be created' }] })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ASSETS_CREATE);
  });

  it('rejects a batch larger than 500 rows', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE]);
    const token = await loginAndGetToken(tenant.username);

    const rows = Array.from({ length: 501 }, (_, i) => ({ name: `Truck ${i}` }));
    await request(app.getHttpServer())
      .post('/v1/imports/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows })
      .expect(400);
  });
});
