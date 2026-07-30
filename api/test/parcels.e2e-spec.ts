/**
 * Multi-parcel per stop + barcode scan: the office pre-lists a stop's parcels
 * from a manifest, the driver scans each (including one that wasn't listed),
 * and the job surfaces a per-stop scanned/total. Scanning is idempotent.
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
];

describe('Stop parcels (multi-parcel + scan)', () => {
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

  async function makeStop(token: string): Promise<{ jobId: string; stopId: string }> {
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Parcel run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Depot drop' }] })
      .expect(201);
    const withStops = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    return { jobId: job.body.id, stopId: withStops.body.stops[0].id };
  }

  it('lists parcels, scans them (idempotently), and surfaces scanned/total on the job', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopId } = await makeStop(token);

    const added = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parcels: [{ reference: 'PARCEL-1' }, { reference: 'PARCEL-2', label: 'Fragile' }] })
      .expect(201);
    expect(added.body.total).toBe(2);
    expect(added.body.scanned).toBe(0);

    // Re-adding an existing reference is a no-op (unique per stop).
    const readd = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parcels: [{ reference: 'PARCEL-1' }] })
      .expect(201);
    expect(readd.body.total).toBe(2);

    // Scan a listed parcel.
    const scan1 = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: 'PARCEL-1' })
      .expect(201);
    expect(scan1.body.scanned).toBe(1);

    // Scanning it again is idempotent.
    const rescan = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: 'PARCEL-1' })
      .expect(201);
    expect(rescan.body.scanned).toBe(1);

    // Scanning an unknown reference adds it already-scanned.
    const scanNew = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: 'SURPRISE-9' })
      .expect(201);
    expect(scanNew.body.total).toBe(3);
    expect(scanNew.body.scanned).toBe(2);

    // Parcels come back nested on the job.
    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(job.body.stops[0].parcels).toHaveLength(3);
  });

  it('requires dispatch:edit to add parcels and dispatch:deliver to scan', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopId } = await makeStop(token);

    const viewer = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const viewerToken = await login(viewer.username);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ parcels: [{ reference: 'X' }] })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ reference: 'X' })
      .expect(403);
  });
});
