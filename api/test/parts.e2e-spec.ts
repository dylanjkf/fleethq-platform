/**
 * Parts inventory basics (06-Workshop/Workshop_Overview.md's "Future
 * expansion notes"): catalog CRUD + archive, low-stock flagging, and logging
 * parts used against a maintenance job (decrementing stock, rejecting
 * insufficient stock, blocked once the job is closed).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.PARTS_VIEW,
  PERMISSIONS.PARTS_CREATE,
  PERMISSIONS.PARTS_EDIT,
  PERMISSIONS.PARTS_ARCHIVE,
  PERMISSIONS.MAINTENANCE_VIEW,
  PERMISSIONS.MAINTENANCE_CREATE,
  PERMISSIONS.MAINTENANCE_CLOSE,
  PERMISSIONS.ASSETS_CREATE,
];

describe('Parts inventory basics', () => {
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

  async function createAsset(token: string, name: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name }).expect(201);
    return res.body.id;
  }

  it('creates, edits (including a stock adjustment), and archives a part', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/parts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Brake pads', partNumber: 'BP-100', quantityOnHand: 10, unitCost: 45.5, lowStockThreshold: 3 })
      .expect(201);
    expect(created.body.name).toBe('Brake pads');
    expect(created.body.quantityOnHand).toBe(10);
    expect(created.body.isLowStock).toBe(false);

    const restocked = await request(app.getHttpServer())
      .patch(`/v1/parts/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantityOnHand: 2 })
      .expect(200);
    expect(restocked.body.quantityOnHand).toBe(2);
    expect(restocked.body.isLowStock).toBe(true);

    await request(app.getHttpServer()).post(`/v1/parts/${created.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    const active = await request(app.getHttpServer()).get('/v1/parts').set('Authorization', `Bearer ${token}`).expect(200);
    expect(active.body.items.map((p: { id: string }) => p.id)).not.toContain(created.body.id);
  });

  it('logs parts used against a maintenance job, decrementing stock and snapshotting unit cost', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await createAsset(token, 'Parts Test Truck');
    const part = await request(app.getHttpServer())
      .post('/v1/parts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Oil filter', quantityOnHand: 5, unitCost: 12 })
      .expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset, title: 'Oil change' })
      .expect(201);

    const usage = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/parts-used`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partId: part.body.id, quantity: 2 })
      .expect(201);
    expect(usage.body.quantity).toBe(2);
    expect(usage.body.unitCostAtUse).toBe(12);
    expect(usage.body.part.name).toBe('Oil filter');

    const partAfter = await request(app.getHttpServer()).get(`/v1/parts/${part.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(partAfter.body.quantityOnHand).toBe(3);

    const jobAfter = await request(app.getHttpServer()).get(`/v1/maintenance-jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(jobAfter.body.partsUsed).toHaveLength(1);
    expect(jobAfter.body.partsUsed[0].part.name).toBe('Oil filter');
  });

  it('rejects logging more than is in stock, and rejects logging against a closed job', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await createAsset(token, 'Insufficient Stock Truck');
    const part = await request(app.getHttpServer())
      .post('/v1/parts')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Wiper blade', quantityOnHand: 1 })
      .expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset, title: 'Wiper replacement' })
      .expect(201);

    const insufficient = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/parts-used`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partId: part.body.id, quantity: 5 })
      .expect(409);
    expect(insufficient.body.error.code).toBe('INSUFFICIENT_STOCK');

    await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/close`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    const afterClose = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/parts-used`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partId: part.body.id, quantity: 1 })
      .expect(409);
    expect(afterClose.body.error.code).toBe('MAINTENANCE_JOB_CLOSED');

    const partUnchanged = await request(app.getHttpServer()).get(`/v1/parts/${part.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(partUnchanged.body.quantityOnHand).toBe(1);
  });

  it('is tenant-isolated', async () => {
    const a = await createTestTenant(FULL);
    const b = await createTestTenant(FULL);
    const tokenB = await login(b.username);
    const partB = await request(app.getHttpServer()).post('/v1/parts').set('Authorization', `Bearer ${tokenB}`).send({ name: 'B Part' }).expect(201);
    const tokenA = await login(a.username);
    await request(app.getHttpServer()).get(`/v1/parts/${partB.body.id}`).set('Authorization', `Bearer ${tokenA}`).expect(404);
  });

  it('requires parts:create to create a part or log usage, and parts:view to list', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.PARTS_VIEW, PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_CREATE, PERMISSIONS.ASSETS_CREATE]);
    const token = await login(viewOnly.username);
    const res = await request(app.getHttpServer()).post('/v1/parts').set('Authorization', `Bearer ${token}`).send({ name: 'X' }).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.PARTS_CREATE);

    const noPerm = await createTestTenant([]);
    const noPermToken = await login(noPerm.username);
    const listDenied = await request(app.getHttpServer()).get('/v1/parts').set('Authorization', `Bearer ${noPermToken}`).expect(403);
    expect(listDenied.body.error.requiredPermission).toBe(PERMISSIONS.PARTS_VIEW);
  });
});
