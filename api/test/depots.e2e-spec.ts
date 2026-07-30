/**
 * Depots (the fleet's own pickup locations, distinct from Customer): CRUD +
 * archive lifecycle, and Job's pickupDepotId — both at create time and via
 * the assign endpoint alongside asset/operator.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.DEPOTS_VIEW,
  PERMISSIONS.DEPOTS_CREATE,
  PERMISSIONS.DEPOTS_EDIT,
  PERMISSIONS.DEPOTS_ARCHIVE,
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_ASSIGN,
  PERMISSIONS.ASSETS_CREATE,
];

describe('Depots', () => {
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

  it('creates, edits, and archives a depot', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/depots')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Main Warehouse', address: '1 Industrial Dr' })
      .expect(201);
    expect(created.body.name).toBe('Main Warehouse');

    const updated = await request(app.getHttpServer())
      .patch(`/v1/depots/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address: '2 Industrial Dr' })
      .expect(200);
    expect(updated.body.address).toBe('2 Industrial Dr');

    await request(app.getHttpServer()).post(`/v1/depots/${created.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    const active = await request(app.getHttpServer()).get('/v1/depots').set('Authorization', `Bearer ${token}`).expect(200);
    expect(active.body.items.map((d: { id: string }) => d.id)).not.toContain(created.body.id);
  });

  it('sets a pickup depot at job creation and changes it via assign', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const depotA = await request(app.getHttpServer()).post('/v1/depots').set('Authorization', `Bearer ${token}`).send({ name: 'Depot A' }).expect(201);
    const depotB = await request(app.getHttpServer()).post('/v1/depots').set('Authorization', `Bearer ${token}`).send({ name: 'Depot B' }).expect(201);

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Run', pickupDepotId: depotA.body.id })
      .expect(201);
    // create() intentionally returns the raw row, not relations — fetch to check.
    const fetched = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(fetched.body.pickupDepot.name).toBe('Depot A');

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ pickupDepotId: depotB.body.id })
      .expect(201);
    const afterReassign = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(afterReassign.body.pickupDepot.name).toBe('Depot B');
  });

  it('is tenant-isolated', async () => {
    const a = await createTestTenant(FULL);
    const b = await createTestTenant(FULL);
    const tokenB = await login(b.username);
    const depotB = await request(app.getHttpServer()).post('/v1/depots').set('Authorization', `Bearer ${tokenB}`).send({ name: 'B Depot' }).expect(201);
    const tokenA = await login(a.username);
    await request(app.getHttpServer()).get(`/v1/depots/${depotB.body.id}`).set('Authorization', `Bearer ${tokenA}`).expect(404);
  });

  it('requires depots:create', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.DEPOTS_VIEW]);
    const token = await login(viewOnly.username);
    const res = await request(app.getHttpServer()).post('/v1/depots').set('Authorization', `Bearer ${token}`).send({ name: 'X' }).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.DEPOTS_CREATE);
  });
});
