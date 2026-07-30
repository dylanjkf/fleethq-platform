/**
 * Delivery time windows, structured failure reasons, and reattempting a
 * failed delivery — three small, additive extensions to the stop-completion
 * flow, tested together since they all touch the same endpoints.
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

describe('Stop extensions: time windows, failure reasons, reattempt', () => {
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

  async function makeJob(token: string, title = 'Run') {
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title, assetId: asset.body.id }).expect(201);
    return { jobId: job.body.id as string, assetId: asset.body.id as string };
  }

  function iso(hoursFromNow: number): string {
    return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
  }

  it('stores a delivery time window on a stop', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await makeJob(token);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Windowed stop', windowStart: iso(1), windowEnd: iso(4) }] })
      .expect(201);

    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(job.body.stops[0].windowStart).toBeTruthy();
    expect(job.body.stops[0].windowEnd).toBeTruthy();
  });

  it('records a structured failure reason, and rejects one paired with DELIVERED', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await makeJob(token);
    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops`).set('Authorization', `Bearer ${token}`).send({ stops: [{ label: 'A' }, { label: 'B' }] }).expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [stopA, stopB] = job.body.stops;

    const completed = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopA.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'FAILED', failureReason: 'NOBODY_HOME', note: 'No answer' })
      .expect(201);
    expect(completed.body.stop.failureReason).toBe('NOBODY_HOME');

    const bad = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopB.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', failureReason: 'NOBODY_HOME' })
      .expect(400);
    expect(bad.body.error.code).toBe('FAILURE_REASON_REQUIRES_FAILED');
  });

  it('reattempts a failed stop into a fresh job, carrying the active asset over, without disturbing the original', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, assetId } = await makeJob(token, 'Morning run');
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'ACME delivery', address: '1 Smith St' }] })
      .expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const stopId = job.body.stops[0].id;

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'FAILED', failureReason: 'ACCESS_DENIED' })
      .expect(201);

    const reattempted = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/reattempt`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    expect(reattempted.body.id).not.toBe(jobId);
    expect(reattempted.body.assetId).toBe(assetId);
    expect(reattempted.body.stops).toHaveLength(1);
    const newStop = reattempted.body.stops[0];
    expect(newStop.label).toBe('ACME delivery');
    expect(newStop.address).toBe('1 Smith St');
    expect(newStop.outcome).toBe('PENDING');
    expect(newStop.reattemptOfStopId).toBe(stopId);

    // The ORIGINAL job/stop is untouched — still FAILED with its own reason.
    const originalAfter = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(originalAfter.body.stops[0].outcome).toBe('FAILED');
    expect(originalAfter.body.stops[0].failureReason).toBe('ACCESS_DENIED');
  });

  it('reattempts onto an existing target job when one is given', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await makeJob(token, 'Run A');
    const { jobId: targetJobId } = await makeJob(token, 'Run B');
    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops`).set('Authorization', `Bearer ${token}`).send({ stops: [{ label: 'Fail me' }] }).expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const stopId = job.body.stops[0].id;
    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops/${stopId}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'FAILED' }).expect(201);

    const reattempted = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/reattempt`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetJobId })
      .expect(201);
    expect(reattempted.body.id).toBe(targetJobId);
    expect(reattempted.body.stops).toHaveLength(1);
  });

  it('rejects reattempting a stop that has not failed', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await makeJob(token);
    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops`).set('Authorization', `Bearer ${token}`).send({ stops: [{ label: 'Pending stop' }] }).expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${job.body.stops[0].id}/reattempt`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409);
    expect(res.body.error.code).toBe('STOP_NOT_FAILED');
  });
});
