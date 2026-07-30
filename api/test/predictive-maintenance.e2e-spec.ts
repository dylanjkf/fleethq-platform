/**
 * Predictive Maintenance signals (09-AI/Fleet_Intelligence_Overview.md +
 * 01-Product/Fleet_Graph.md's own named multi-hop example): deterministic,
 * non-AI pattern detection over Maintenance fault history and Fleet Graph
 * PAIRED_WITH relationships. No OBD/CAN-derived signal — that data source
 * doesn't exist yet.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.ATTACHED_UNITS_CREATE,
  PERMISSIONS.ATTACHED_UNITS_EDIT,
  PERMISSIONS.MAINTENANCE_VIEW,
  PERMISSIONS.MAINTENANCE_CREATE,
];

describe('Predictive Maintenance signals', () => {
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

  async function createFault(token: string, assetId: string, title: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId, title })
      .expect(201);
    return res.body.id;
  }

  it('flags a recurring fault once the same title occurs twice on one asset, not on the first occurrence', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const assetId = await createAsset(token, 'Recurring Fault Truck');

    await createFault(token, assetId, 'Suspension noise');
    const afterFirst = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(afterFirst.body.some((s: { type: string; title: string }) => s.type === 'RECURRING_FAULT' && s.title === 'Suspension noise')).toBe(false);

    await createFault(token, assetId, 'Suspension noise');
    const afterSecond = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const signal = afterSecond.body.find((s: { type: string; title: string }) => s.type === 'RECURRING_FAULT' && s.title === 'Suspension noise');
    expect(signal).toBeDefined();
    expect(signal.occurrenceCount).toBe(2);
    expect(signal.assetIds).toEqual([assetId]);
  });

  it('flags a shared attached-unit pattern when 2+ paired assets develop a matching fault after pairing, excluding a pre-pairing fault', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const unit = await request(app.getHttpServer())
      .post('/v1/attached-units')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Shared Trailer' })
      .expect(201);
    const assetA = await createAsset(token, 'Pattern Asset A');
    const assetB = await createAsset(token, 'Pattern Asset B');

    // Asset A gets a matching fault BEFORE ever being paired — must not count.
    await createFault(token, assetA, 'Brake wear');

    await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/hitch`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetA })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/unhitch`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/hitch`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetB })
      .expect(201);

    // Only asset B's post-pairing fault should count so far — one asset, below threshold.
    await createFault(token, assetB, 'Brake wear');
    const belowThreshold = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      belowThreshold.body.some((s: { type: string; title: string }) => s.type === 'SHARED_ATTACHED_UNIT_PATTERN' && s.title === 'Brake wear'),
    ).toBe(false);

    // Re-pair asset A, then give it a fresh matching fault AFTER re-pairing.
    await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/hitch`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetA })
      .expect(201);
    await createFault(token, assetA, 'Brake wear');

    const res = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const signal = res.body.find((s: { type: string; title: string }) => s.type === 'SHARED_ATTACHED_UNIT_PATTERN' && s.title === 'Brake wear');
    expect(signal).toBeDefined();
    expect(signal.occurrenceCount).toBe(2);
    expect(new Set(signal.assetIds)).toEqual(new Set([assetA, assetB]));
    expect(signal.attachedUnitName).toBe('Shared Trailer');
  });

  it('requires maintenance:view and is tenant-isolated', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const assetId = await createAsset(token, 'Isolated Truck');
    await createFault(token, assetId, 'Oil leak');
    await createFault(token, assetId, 'Oil leak');

    const noPerm = await createTestTenant([]);
    const noPermToken = await login(noPerm.username);
    const denied = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.MAINTENANCE_VIEW);

    const other = await createTestTenant(FULL);
    const otherToken = await login(other.username);
    const otherRes = await request(app.getHttpServer())
      .get('/v1/predictive-maintenance/signals')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(otherRes.body).toHaveLength(0);
  });
});
