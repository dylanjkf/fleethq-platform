/**
 * Notification preferences (alert-fatigue control, FOUNDER_NOTES.md's
 * "notifications as its own system" gap): a digest-only user still gets
 * every notification recorded — and still shows up in an email digest —
 * but the live in-app unread badge stays at zero rather than nagging them.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, addUserToCompany, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ACTOR = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.ASSETS_CREATE,
];

describe('Notification preferences', () => {
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

  it('defaults to live (not digest-only), and the toggle round-trips', async () => {
    const tenant = await createTestTenant(ACTOR);
    const token = await login(tenant.username);

    const initial = await request(app.getHttpServer()).get('/v1/notifications/preferences').set('Authorization', `Bearer ${token}`).expect(200);
    expect(initial.body.digestOnly).toBe(false);

    const updated = await request(app.getHttpServer())
      .patch('/v1/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ digestOnly: true })
      .expect(200);
    expect(updated.body.digestOnly).toBe(true);

    const after = await request(app.getHttpServer()).get('/v1/notifications/preferences').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.digestOnly).toBe(true);
  });

  it('suppresses the live unread badge for a digest-only user without dropping the notification itself', async () => {
    const actor = await createTestTenant(ACTOR);
    const watcher = await addUserToCompany(actor.companyId, [PERMISSIONS.DISPATCH_VIEW], 'Ops Watcher');
    const actorToken = await login(actor.username);
    const watcherToken = await login(watcher.username);

    await request(app.getHttpServer())
      .patch('/v1/notifications/preferences')
      .set('Authorization', `Bearer ${watcherToken}`)
      .send({ digestOnly: true })
      .expect(200);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${actorToken}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${actorToken}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops`).set('Authorization', `Bearer ${actorToken}`).send({ stops: [{ label: '1 High St' }] }).expect(201);
    const jobFull = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${actorToken}`).expect(200);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${jobFull.body.stops[0].id}/complete`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ outcome: 'FAILED', note: 'Nobody home' })
      .expect(201);

    const watcherNotifs = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${watcherToken}`).expect(200);
    // Unread badge suppressed...
    expect(watcherNotifs.body.unreadCount).toBe(0);
    // ...but the notification itself was recorded, still visible in the list and available to the digest.
    expect(watcherNotifs.body.items.some((n: { type: string }) => n.type === 'delivery_failed')).toBe(true);
  });

  it('requires no special permission — every user manages their own preference', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    await request(app.getHttpServer())
      .patch('/v1/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ digestOnly: true })
      .expect(200);
  });

  it('lists the fixed notification-type catalog', async () => {
    const tenant = await createTestTenant([]);
    const token = await login(tenant.username);
    const res = await request(app.getHttpServer()).get('/v1/notifications/types').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.some((t: { key: string }) => t.key === 'delivery_failed')).toBe(true);
  });

  it('rejects an unknown notification type in mutedTypes', async () => {
    const tenant = await createTestTenant([]);
    const token = await login(tenant.username);
    await request(app.getHttpServer())
      .patch('/v1/notifications/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ mutedTypes: ['not_a_real_type'] })
      .expect(400);
  });

  it('never records a notification of a muted type, so it never hits the unread badge or the digest', async () => {
    const actor = await createTestTenant(ACTOR);
    const watcher = await addUserToCompany(actor.companyId, [PERMISSIONS.DISPATCH_VIEW], 'Muted Watcher');
    const actorToken = await login(actor.username);
    const watcherToken = await login(watcher.username);

    await request(app.getHttpServer())
      .patch('/v1/notifications/preferences')
      .set('Authorization', `Bearer ${watcherToken}`)
      .send({ mutedTypes: ['delivery_failed'] })
      .expect(200);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${actorToken}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${actorToken}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops`).set('Authorization', `Bearer ${actorToken}`).send({ stops: [{ label: '1 High St' }] }).expect(201);
    const jobFull = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${actorToken}`).expect(200);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${jobFull.body.stops[0].id}/complete`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ outcome: 'FAILED', note: 'Nobody home' })
      .expect(201);

    const watcherNotifs = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${watcherToken}`).expect(200);
    expect(watcherNotifs.body.items.some((n: { type: string }) => n.type === 'delivery_failed')).toBe(false);
  });
});
