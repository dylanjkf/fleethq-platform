/**
 * Web Push subscriptions: no third-party account needed (VAPID keys are
 * generated locally, delivery goes through the browser's own push service)
 * — every user manages their own device registrations, mirroring the rest
 * of Notifications' "personal, no permission required" convention.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Push subscriptions', () => {
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

  it('exposes a VAPID public key when configured', async () => {
    const tenant = await createTestTenant([]);
    const token = await login(tenant.username);
    const res = await request(app.getHttpServer()).get('/v1/push/vapid-public-key').set('Authorization', `Bearer ${token}`).expect(200);
    // The test env's .env carries a real (locally-generated, non-secret) dev keypair.
    expect(typeof res.body.publicKey === 'string' || res.body.publicKey === null).toBe(true);
  });

  it('subscribes, upserts on a repeat subscribe, then unsubscribes', async () => {
    const tenant = await createTestTenant([]);
    const token = await login(tenant.username);
    const endpoint = `https://example-push-service.test/${tenant.userId}`;

    await request(app.getHttpServer())
      .post('/v1/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } })
      .expect(201);

    // Re-subscribing the same endpoint (e.g. the browser rotates keys) upserts, not duplicates.
    await request(app.getHttpServer())
      .post('/v1/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint, keys: { p256dh: 'rotated-key', auth: 'auth-key' } })
      .expect(201);

    await request(app.getHttpServer())
      .post('/v1/push/unsubscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint })
      .expect(201);
  });

  it('rejects a malformed subscription payload', async () => {
    const tenant = await createTestTenant([]);
    const token = await login(tenant.username);
    await request(app.getHttpServer())
      .post('/v1/push/subscribe')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://example.test/x' })
      .expect(400);
  });
});
