/**
 * Notifications (cross-cutting v0): a failed delivery fans out to everyone who
 * watches Dispatch (except the actor), and the recipient can list and clear
 * their unread notifications. Verifies the fan-out, the actor-exclusion, and the
 * mark-read flow.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  addUserToCompany,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const ACTOR = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.OPERATORS_CREATE,
];

describe('Notifications (cross-cutting)', () => {
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

  it('notifies Dispatch watchers of a failed delivery, but not the actor', async () => {
    const actor = await createTestTenant(ACTOR);
    const watcher = await addUserToCompany(actor.companyId, [PERMISSIONS.DISPATCH_VIEW], 'Ops Watcher');
    const actorToken = await login(actor.username);
    const watcherToken = await login(watcher.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${actorToken}`).send({ name: 'Van 1' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${actorToken}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops`).set('Authorization', `Bearer ${actorToken}`).send({ stops: [{ label: '1 High St' }] }).expect(201);
    const jobFull = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${actorToken}`).expect(200);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${jobFull.body.stops[0].id}/complete`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ outcome: 'FAILED', note: 'Nobody home' })
      .expect(201);

    // The watcher is notified.
    const watcherNotifs = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${watcherToken}`).expect(200);
    expect(watcherNotifs.body.unreadCount).toBeGreaterThanOrEqual(1);
    const failNotif = watcherNotifs.body.items.find((n: { type: string }) => n.type === 'delivery_failed');
    expect(failNotif).toBeDefined();
    expect(failNotif.title).toContain('Delivery failed');

    // The actor who caused it is NOT notified.
    const actorNotifs = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${actorToken}`).expect(200);
    expect(actorNotifs.body.items.some((n: { type: string }) => n.type === 'delivery_failed')).toBe(false);

    // Mark read clears the unread count.
    await request(app.getHttpServer()).post(`/v1/notifications/${failNotif.id}/read`).set('Authorization', `Bearer ${watcherToken}`).expect(201);
    const after = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${watcherToken}`).expect(200);
    expect(after.body.items.find((n: { id: string }) => n.id === failNotif.id).readAt).not.toBeNull();
  });

  it('is tenant-isolated and personal — a user only sees their own', async () => {
    const a = await createTestTenant(ACTOR);
    const b = await createTestTenant(ACTOR);
    const tokenB = await login(b.username);
    // B (a different company/user) has no notifications from A's activity.
    const res = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${tokenB}`).expect(200);
    expect(res.body.unreadCount).toBe(0);
    expect(a.companyId).not.toBe(b.companyId);
  });
});
