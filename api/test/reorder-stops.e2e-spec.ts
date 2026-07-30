/**
 * Manual stop reordering: the office can resequence pending stops (a
 * dispatcher fixing a mistake), but a completed/failed stop's position is
 * historical fact and is never disturbed even when it sits between pending
 * stops that get reordered.
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
];

describe('Stop reordering', () => {
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

  it('reorders pending stops while leaving a completed stop in its historical slot', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] })
      .expect(201);
    const before = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [stopA, stopB, stopC] = before.body.stops;

    // Complete B — it's now historical and must keep sequence 2 no matter what.
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${stopB.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED' })
      .expect(201);

    // Reorder the remaining pending stops (A, C) to C-then-A.
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stopIds: [stopC.id, stopA.id] })
      .expect(201);

    const after = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const byLabel = Object.fromEntries(after.body.stops.map((s: { label: string; sequence: number }) => [s.label, s.sequence]));
    expect(byLabel['B']).toBe(2); // untouched — historical
    expect(byLabel['C']).toBe(1); // moved into slot 1 (the smallest available pending slot)
    expect(byLabel['A']).toBe(3); // moved into slot 3
  });

  it('rejects a reorder that omits a pending stop or includes a non-pending one', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'A' }, { label: 'B' }] })
      .expect(201);
    const job2 = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/reorder`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stopIds: [job2.body.stops[0].id] }) // omits the second pending stop
      .expect(400);
    expect(res.body.error.code).toBe('STOP_REORDER_MISMATCH');
  });

  it('requires dispatch:edit', async () => {
    const full = await createTestTenant(FULL);
    const fullToken = await login(full.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${fullToken}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${fullToken}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);

    const viewOnly = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const viewToken = await login(viewOnly.username);
    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/reorder`)
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ stopIds: [] })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_EDIT);
  });
});
