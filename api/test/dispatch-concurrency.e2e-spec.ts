/**
 * Concurrency guards (A2): completeStop and scanParcel both did a check-then-
 * write under READ COMMITTED, so two concurrent requests on the same target
 * could race. completeStop now runs under SERIALIZABLE (like verifyLoad) so a
 * double-tap / offline-replay can't double-record a completion (duplicate
 * timeline events + notifications); scanParcel catches the P2002 on
 * @@unique([stopId, reference]) and treats it as idempotent success instead of a
 * 500. These tests fire two concurrent requests (Promise.all) and assert the
 * settled state, mirroring load-verification.e2e-spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [PERMISSIONS.DISPATCH_VIEW, PERMISSIONS.DISPATCH_CREATE, PERMISSIONS.DISPATCH_EDIT, PERMISSIONS.DISPATCH_DELIVER];

describe('Dispatch concurrency guards (A2)', () => {
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

  async function seedStop(token: string): Promise<{ jobId: string; stopId: string }> {
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Concurrency run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Stop A' }] })
      .expect(201);
    const withStops = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    return { jobId: job.body.id, stopId: withStops.body.stops[0].id };
  }

  it('completeStop: two concurrent FAILED completions record the completion exactly once (no duplicate events or notifications)', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopId } = await seedStop(token);

    const fire = () =>
      request(app.getHttpServer())
        .post(`/v1/jobs/${jobId}/stops/${stopId}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ outcome: 'FAILED', note: 'Nobody home' });
    const [r1, r2] = await Promise.all([fire(), fire()]);

    // Neither races into a 500; both settle as 201 (one real, one replayed).
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect([r1.body.replayed, r2.body.replayed].sort()).toEqual([false, true]);

    // Exactly ONE stop_completed timeline event and ONE delivery_failed
    // notification — no duplicate from the race.
    const events = await prisma.timelineEvent.findMany({ where: { entityId: jobId, eventType: 'stop_completed' } });
    expect(events).toHaveLength(1);
    const notes = await prisma.notification.findMany({ where: { companyId: tenant.companyId, type: 'delivery_failed' } });
    expect(notes).toHaveLength(1);
  });

  it('scanParcel: two concurrent scans of the same NEW reference succeed idempotently (no unhandled 500)', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopId } = await seedStop(token);

    const fire = () =>
      request(app.getHttpServer())
        .post(`/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reference: 'X-1' });
    const [r1, r2] = await Promise.all([fire(), fire()]);

    // Both succeed — the loser of the create race is NOT a 500.
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // Exactly one parcel row exists for the reference, and it's scanned.
    const parcels = await prisma.stopParcel.findMany({ where: { stopId, reference: 'X-1' } });
    expect(parcels).toHaveLength(1);
    expect(parcels[0].scannedAt).toBeTruthy();
  });
});
