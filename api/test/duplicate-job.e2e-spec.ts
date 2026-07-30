/**
 * Repeat a run: duplicating a job clones its title/asset/operator and stops
 * into a fresh job with clean PENDING stops (no completion data carried over),
 * dropping the asset/operator only if either has since been archived.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.ASSETS_ARCHIVE,
  PERMISSIONS.OPERATORS_CREATE,
];

describe('Repeat a run (duplicate job)', () => {
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

  it('clones title/asset/operator/stops into a fresh job with clean pending stops', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Dana Driver' }).expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Morning run', assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Stop A' }, { label: 'Stop B' }] })
      .expect(201);
    const original = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    // Complete stop A so we can prove completion data does NOT carry over.
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${original.body.stops[0].id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', recipientName: 'Someone' })
      .expect(201);

    const dup = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);

    expect(dup.body.id).not.toBe(job.body.id);
    expect(dup.body.title).toBe('Morning run');
    expect(dup.body.assetId).toBe(asset.body.id);
    expect(dup.body.operatorId).toBe(operator.body.id);
    expect(dup.body.status).toBe('ASSIGNED');
    expect(dup.body.stops).toHaveLength(2);
    expect(dup.body.stops.map((s: { label: string }) => s.label)).toEqual(['Stop A', 'Stop B']);
    expect(dup.body.stops.every((s: { outcome: string; recipientName: string | null }) => s.outcome === 'PENDING' && !s.recipientName)).toBe(true);
  });

  it('drops the asset if it has since been archived, leaving the duplicate unassigned for that side', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Old Van' }).expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Run', assetId: asset.body.id })
      .expect(201);
    await request(app.getHttpServer()).post(`/v1/assets/${asset.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    const dup = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect(dup.body.assetId).toBeNull();
    expect(dup.body.status).toBe('UNASSIGNED');
  });

  it('requires dispatch:create', async () => {
    const full = await createTestTenant(FULL);
    const fullToken = await login(full.username);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${fullToken}`).send({ title: 'Run' }).expect(201);

    const viewOnly = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const viewToken = await login(viewOnly.username);
    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/duplicate`)
      .set('Authorization', `Bearer ${viewToken}`)
      .send({})
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_CREATE);
  });
});
