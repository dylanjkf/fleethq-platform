/**
 * Asset specs + detail aggregate: a company can enrich an asset with structured
 * specs (make/model/odometer/…) plus free-form custom fields, and open a detail
 * view that aggregates the asset with its maintenance/compliance/checklist activity.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_EDIT, PERMISSIONS.ASSETS_ARCHIVE, PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_CREATE];

describe('Asset specs + detail', () => {
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

  async function login(username: string): Promise<Record<string, string>> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  it('stores specs + custom fields and returns them on the detail aggregate', async () => {
    const tenant = await createTestTenant(FULL);
    const auth = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/assets')
      .set(auth)
      .send({ name: 'Truck 12', make: 'Isuzu', model: 'NPR', year: 2021, odometer: 84000, odometerUnit: 'km', registration: 'ABC123', customFields: { tyreSize: '225/75' } })
      .expect(201);
    expect(created.body.make).toBe('Isuzu');
    expect(created.body.odometer).toBe(84000);
    expect(created.body.customFields).toEqual({ tyreSize: '225/75' });

    // A maintenance job so the detail aggregate has activity to roll up.
    await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set(auth)
      .send({ assetId: created.body.id, title: 'Brake check', description: 'Front pads' })
      .expect(201);

    const detail = await request(app.getHttpServer()).get(`/v1/assets/${created.body.id}/detail`).set(auth).expect(200);
    expect(detail.body.asset.model).toBe('NPR');
    expect(detail.body.maintenance).toHaveLength(1);
    expect(detail.body.summary.openMaintenanceCount).toBe(1);

    // Updating odometer persists and is reflected.
    const updated = await request(app.getHttpServer()).patch(`/v1/assets/${created.body.id}`).set(auth).send({ odometer: 90000 }).expect(200);
    expect(updated.body.odometer).toBe(90000);
  });

  it('detail is tenant-isolated', async () => {
    const a = await createTestTenant(FULL);
    const b = await createTestTenant(FULL);
    const authA = await login(a.username);
    const authB = await login(b.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set(authA).send({ name: 'A truck' }).expect(201);
    await request(app.getHttpServer()).get(`/v1/assets/${asset.body.id}/detail`).set(authB).expect(404);
  });

  it('rejects a duplicate active VIN within a company with a clean 409, and allows reuse after archiving', async () => {
    const tenant = await createTestTenant(FULL);
    const auth = await login(tenant.username);

    const first = await request(app.getHttpServer())
      .post('/v1/assets')
      .set(auth)
      .send({ name: 'Truck A', vin: '1HGCM82633A004352' })
      .expect(201);

    // Same VIN, still-active first asset → 409 with the app-authored code.
    const dup = await request(app.getHttpServer())
      .post('/v1/assets')
      .set(auth)
      .send({ name: 'Truck B', vin: '1HGCM82633A004352' })
      .expect(409);
    expect(dup.body.error.code).toBe('ASSET_VIN_TAKEN');

    // Archiving the first frees the VIN for a replacement (partial index
    // excludes archived rows).
    await request(app.getHttpServer()).post(`/v1/assets/${first.body.id}/archive`).set(auth).expect(201);
    await request(app.getHttpServer())
      .post('/v1/assets')
      .set(auth)
      .send({ name: 'Truck B', vin: '1HGCM82633A004352' })
      .expect(201);
  });

  it('scopes VIN uniqueness per company (another tenant can hold the same VIN)', async () => {
    const a = await createTestTenant(FULL);
    const b = await createTestTenant(FULL);
    const authA = await login(a.username);
    const authB = await login(b.username);
    await request(app.getHttpServer()).post('/v1/assets').set(authA).send({ name: 'A', vin: 'SHAREDVIN123' }).expect(201);
    await request(app.getHttpServer()).post('/v1/assets').set(authB).send({ name: 'B', vin: 'SHAREDVIN123' }).expect(201);
  });
});
