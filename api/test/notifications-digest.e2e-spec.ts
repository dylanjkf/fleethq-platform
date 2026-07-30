/**
 * Email digest notification channel (Notification.emailedAt's doc comment):
 * there's no real SMTP provider wired up yet, so "sending" a digest means
 * computing what each recipient's unread/un-emailed notifications would say
 * and marking them emailedAt, so a later run never double-sends. Preview is
 * the same computation without marking anything.
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
  PERMISSIONS.NOTIFICATIONS_DIGEST_SEND,
];

describe('Email digest notification channel', () => {
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

  async function raiseFailedDeliveryNotification(actorToken: string) {
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${actorToken}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${actorToken}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops`).set('Authorization', `Bearer ${actorToken}`).send({ stops: [{ label: '1 High St' }] }).expect(201);
    const jobFull = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${actorToken}`).expect(200);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops/${jobFull.body.stops[0].id}/complete`)
      .set('Authorization', `Bearer ${actorToken}`)
      .send({ outcome: 'FAILED', note: 'Nobody home' })
      .expect(201);
  }

  it('previews and then sends a digest, marking notifications emailed so a repeat send is empty', async () => {
    const actor = await createTestTenant(ACTOR);
    // Watcher has an email → they're an emailable recipient, so recipientCount counts them.
    const watcher = await addUserToCompany(actor.companyId, [PERMISSIONS.DISPATCH_VIEW], 'Ops Watcher', 'ops.watcher@example.com');
    const actorToken = await login(actor.username);
    const watcherToken = await login(watcher.username);

    await raiseFailedDeliveryNotification(actorToken);

    const preview = await request(app.getHttpServer()).get('/v1/notifications/digest/preview').set('Authorization', `Bearer ${actorToken}`).expect(200);
    expect(preview.body.recipientCount).toBe(1);
    expect(preview.body.skippedCount).toBe(0);
    expect(preview.body.recipients[0].fullName).toBe('Ops Watcher');
    expect(preview.body.recipients[0].itemCount).toBeGreaterThanOrEqual(1);

    const sent = await request(app.getHttpServer()).post('/v1/notifications/digest/send').set('Authorization', `Bearer ${actorToken}`).expect(201);
    expect(sent.body.recipientCount).toBe(1);

    // The digest doesn't mark the notification READ — only emailed. Unread count is unaffected.
    const watcherNotifs = await request(app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${watcherToken}`).expect(200);
    expect(watcherNotifs.body.unreadCount).toBeGreaterThanOrEqual(1);

    // A repeat send has nothing left to email.
    const secondSend = await request(app.getHttpServer()).post('/v1/notifications/digest/send').set('Authorization', `Bearer ${actorToken}`).expect(201);
    expect(secondSend.body.recipientCount).toBe(0);
  });

  it('counts a recipient with no email as skipped, not emailed', async () => {
    const actor = await createTestTenant(ACTOR);
    // No email → has pending items so still appears in `recipients`, but is
    // reached in-app only, so it must not inflate the "sent to N people" count.
    await addUserToCompany(actor.companyId, [PERMISSIONS.DISPATCH_VIEW], 'No Email Watcher');
    const actorToken = await login(actor.username);

    await raiseFailedDeliveryNotification(actorToken);

    const preview = await request(app.getHttpServer()).get('/v1/notifications/digest/preview').set('Authorization', `Bearer ${actorToken}`).expect(200);
    expect(preview.body.recipients.some((r: { fullName: string }) => r.fullName === 'No Email Watcher')).toBe(true);
    expect(preview.body.recipientCount).toBe(0);
    expect(preview.body.skippedCount).toBeGreaterThanOrEqual(1);
  });

  it('requires notifications:digest_send', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    const res = await request(app.getHttpServer()).get('/v1/notifications/digest/preview').set('Authorization', `Bearer ${token}`).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.NOTIFICATIONS_DIGEST_SEND);
  });
});
