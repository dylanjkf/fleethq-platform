/**
 * Load verification (item 2): before a driver starts a run they confirm the
 * vehicle's actual load against the run's expected manifest — the aggregate of
 * the job's stops' StopParcel rows. A clean load verifies cleanly; a manifest
 * with an unscanned parcel surfaces a discrepancy and a confirm without an
 * explicit override is rejected, so a partial load can't start unacknowledged.
 * An override records who overrode and exactly what was missing on the JOB
 * timeline. These tests must fail if the discrepancy gate or the override audit
 * were removed.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
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

describe('Load verification (item 2)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  /** A job with two stops, each carrying parcels pre-listed from a manifest. */
  async function seedJob(token: string): Promise<{ jobId: string; stopIds: string[] }> {
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Load run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Stop A' }, { label: 'Stop B' }] })
      .expect(201);
    const withStops = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const stopIds = withStops.body.stops.map((s: { id: string }) => s.id);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${stopIds[0]}/parcels`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parcels: [{ reference: 'A-1' }, { reference: 'A-2' }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${stopIds[1]}/parcels`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parcels: [{ reference: 'B-1' }] })
      .expect(201);
    return { jobId: job.body.id, stopIds };
  }

  async function scan(token: string, jobId: string, stopId: string, reference: string) {
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference })
      .expect(201);
  }

  it('(a) a fully-scanned manifest shows no discrepancy and verifies cleanly', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopIds } = await seedJob(token);

    // Scan every expected parcel (manual "mark loaded" is this same scan path).
    await scan(token, jobId, stopIds[0], 'A-1');
    await scan(token, jobId, stopIds[0], 'A-2');
    await scan(token, jobId, stopIds[1], 'B-1');

    const status = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}/load-status`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.expectedTotal).toBe(3);
    expect(status.body.scannedTotal).toBe(3);
    expect(status.body.discrepancies).toHaveLength(0);
    expect(status.body.stops).toHaveLength(2);

    const verify = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/load-verification`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: true })
      .expect(201);
    expect(verify.body.verified).toBe(true);
    expect(verify.body.loadVerifiedAt).toBeTruthy();

    const events = await prisma.timelineEvent.findMany({ where: { entityId: jobId, eventType: 'load_verified' } });
    expect(events).toHaveLength(1);
    expect((events[0].payload as { expectedTotal: number }).expectedTotal).toBe(3);
  });

  it('(b) an unscanned parcel surfaces a discrepancy and a confirm without override is rejected', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopIds } = await seedJob(token);

    // Scan all but B-1 — a partial load.
    await scan(token, jobId, stopIds[0], 'A-1');
    await scan(token, jobId, stopIds[0], 'A-2');

    const status = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}/load-status`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(status.body.scannedTotal).toBe(2);
    expect(status.body.expectedTotal).toBe(3);
    expect(status.body.discrepancies).toHaveLength(1);
    expect(status.body.discrepancies[0].reference).toBe('B-1');

    // A confirm WITHOUT the override flag must be rejected so the run can't
    // start on a partial load unacknowledged.
    const rejected = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/load-verification`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: true })
      .expect(409);
    expect(rejected.body.error.code).toBe('LOAD_DISCREPANCY');
    expect(rejected.body.error.missingReferences).toEqual(['B-1']);

    // Nothing was verified or recorded.
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    expect(job!.loadVerifiedAt).toBeNull();
    const events = await prisma.timelineEvent.findMany({ where: { entityId: jobId, eventType: { in: ['load_verified', 'load_discrepancy_override'] } } });
    expect(events).toHaveLength(0);
  });

  it('(c) an override records who overrode and exactly what was missing on the JOB timeline', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopIds } = await seedJob(token);

    await scan(token, jobId, stopIds[0], 'A-1');
    // A-2 and B-1 left unscanned.

    const verify = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/load-verification`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: true, override: true, missingReferences: ['A-2', 'B-1'] })
      .expect(201);
    expect(verify.body.verified).toBe(true);
    expect(verify.body.loadVerifiedAt).toBeTruthy();

    const events = await prisma.timelineEvent.findMany({ where: { entityId: jobId, eventType: 'load_discrepancy_override' } });
    expect(events).toHaveLength(1);
    const event = events[0];
    // WHO: the acting user.
    expect(event.actorUserId).toBe(tenant.userId);
    expect(event.actorType).toBe('USER');
    // WHEN: the event time exists.
    expect(event.occurredAt).toBeTruthy();
    // WHAT WAS MISSING: server-computed missing references.
    const payload = event.payload as { missingReferences: string[]; missingCount: number };
    expect(payload.missingReferences.sort()).toEqual(['A-2', 'B-1']);
    expect(payload.missingCount).toBe(2);

    // The job is now marked verified.
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    expect(job!.loadVerifiedAt).toBeTruthy();
  });

  it('load-status requires dispatch:view and verification requires dispatch:deliver', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId } = await seedJob(token);

    // A user with neither permission.
    const outsider = await createTestTenant([PERMISSIONS.DISPATCH_CREATE]);
    const outsiderToken = await login(outsider.username);

    await request(app.getHttpServer()).get(`/v1/jobs/${jobId}/load-status`).set('Authorization', `Bearer ${outsiderToken}`).expect(403);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/load-verification`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ confirm: true })
      .expect(403);
  });
});
