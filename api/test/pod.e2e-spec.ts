/**
 * Multi-stop delivery runs + Proof of Delivery: office adds ordered stops, the
 * operator completes each with an outcome + recipient + note + photo, the photo
 * is stored as an Attachment, and the job rolls up to COMPLETED once every stop
 * is terminal. Also covers idempotent offline replay and permission gating.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const FULL = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_ASSIGN,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.ATTACHMENTS_VIEW,
];

describe('Proof of Delivery + multi-stop runs', () => {
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
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  async function setup(token: string) {
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van 03' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Dana Driver' }).expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Morning run', assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);
    return { assetId: asset.body.id, operatorId: operator.body.id, jobId: job.body.id };
  }

  it('adds stops, completes them with proof, and rolls the job up to COMPLETED', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await setup(token);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: '12 Smith St — ACME', contactName: 'Reception' }, { label: '9 Jones Ave' }] })
      .expect(201);

    const withStops = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(withStops.body.stops).toHaveLength(2);
    expect(withStops.body.stops[0].sequence).toBe(1);
    expect(withStops.body.stops.every((s: { outcome: string }) => s.outcome === 'PENDING')).toBe(true);
    const [stop1, stop2] = withStops.body.stops;

    // Deliver stop 1 with a proof photo.
    const c1 = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stop1.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', recipientName: 'J. Smith', podPhotoBase64: PNG_B64, podPhotoContentType: 'image/png' })
      .expect(201);
    expect(c1.body.stop.outcome).toBe('DELIVERED');
    expect(c1.body.jobCompleted).toBe(false); // one stop still pending

    // The stored proof photo is downloadable.
    const jobMid = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const podId = jobMid.body.stops.find((s: { id: string }) => s.id === stop1.id).podAttachment.id;
    await request(app.getHttpServer()).get(`/v1/attachments/${podId}`).set('Authorization', `Bearer ${token}`).expect(200);

    // Fail stop 2 → all stops terminal → job COMPLETED.
    const c2 = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stop2.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'FAILED', note: 'Nobody home, no safe drop.' })
      .expect(201);
    expect(c2.body.jobCompleted).toBe(true);
    expect(c2.body.job.status).toBe('COMPLETED');
  });

  it('captures a recipient signature alongside (or instead of) a photo', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await setup(token);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Signature-only drop' }] })
      .expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const stopId = job.body.stops[0].id;

    const completed = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', recipientName: 'J. Smith', signatureBase64: PNG_B64, signatureContentType: 'image/png' })
      .expect(201);
    expect(completed.body.stop.signatureAttachmentId).toBeDefined();
    expect(completed.body.stop.podAttachmentId).toBeNull();

    const withSignature = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const sigId = withSignature.body.stops.find((s: { id: string }) => s.id === stopId).signatureAttachment.id;
    const download = await request(app.getHttpServer())
      .get(`/v1/attachments/${sigId}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(download.body as Buffer, Buffer.from(PNG_B64, 'base64'))).toBe(0);
  });

  it('is idempotent when the same stop completion replays', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await setup(token);
    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops`).set('Authorization', `Bearer ${token}`).send({ stops: [{ label: 'A' }] }).expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const stopId = job.body.stops[0].id;

    const first = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops/${stopId}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    expect(first.body.replayed).toBe(false);
    const replay = await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops/${stopId}/complete`).set('Authorization', `Bearer ${token}`).send({ outcome: 'DELIVERED' }).expect(201);
    expect(replay.body.replayed).toBe(true);
  });

  it('produces a printable PDF receipt for a completed stop, and refuses one for a pending stop', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await setup(token);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: '12 Smith St', address: '12 Smith St, Melbourne VIC' }, { label: 'Pending drop' }] })
      .expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [done, pending] = job.body.stops;

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${done.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', recipientName: 'J. Smith', note: 'Left at reception', podPhotoBase64: PNG_B64, podPhotoContentType: 'image/png', signatureBase64: PNG_B64, signatureContentType: 'image/png' })
      .expect(201);

    const receipt = await request(app.getHttpServer())
      .get(`/v1/jobs/${jobId}/stops/${done.id}/receipt`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(receipt.headers['content-type']).toContain('application/pdf');
    expect((receipt.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    // A stop with no proof yet can't have a receipt.
    const refused = await request(app.getHttpServer())
      .get(`/v1/jobs/${jobId}/stops/${pending.id}/receipt`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(refused.body.error.code).toBe('STOP_NOT_COMPLETED');
  });

  it('requires dispatch:deliver to complete a stop', async () => {
    const full = await createTestTenant(FULL);
    const fullToken = await login(full.username);
    const { jobId } = await setup(fullToken);
    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/stops`).set('Authorization', `Bearer ${fullToken}`).send({ stops: [{ label: 'A' }] }).expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${fullToken}`).expect(200);

    // A viewer without dispatch:deliver, same company can't reach the stop anyway;
    // use a permissionless-for-deliver token in the SAME tenant via a fresh role.
    const viewer = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const viewerToken = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${job.body.stops[0].id}/complete`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ outcome: 'DELIVERED' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_DELIVER);
  });

  it('records an offline delivery at its real time (occurredAt), but never trusts a bad clock', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await setup(token);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Real-time drop' }, { label: 'Future-clock drop' }] })
      .expect(201);
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    const [stop1, stop2] = job.body.stops;

    // An offline delivery that syncs later: completedAt is the real delivery
    // time it carried, not the (later) sync time.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const c1 = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stop1.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', occurredAt: twoHoursAgo })
      .expect(201);
    expect(new Date(c1.body.stop.completedAt).toISOString()).toBe(twoHoursAgo);

    // A device clock running fast can't backdate the future — clamped to ~now.
    const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const c2 = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stop2.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'DELIVERED', occurredAt: future })
      .expect(201);
    expect(new Date(c2.body.stop.completedAt).getTime()).toBeLessThan(new Date(future).getTime());
    expect(Date.now() - new Date(c2.body.stop.completedAt).getTime()).toBeLessThan(60_000);
  });
});
