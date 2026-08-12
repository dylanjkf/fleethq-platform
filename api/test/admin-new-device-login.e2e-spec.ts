/**
 * New-device / new-location sign-in NOTIFICATION for the FleetHQ admin
 * console — the admin-side equivalent of the customer new-device-login email
 * (AuthService.finishLoginForMembership). A staff admin signing in from an
 * IP + user-agent pair the account hasn't been seen on before gets a
 * best-effort security email pointing at the admin session review/revoke page
 * (/admin/settings). Signing in again from the SAME device must NOT re-alert.
 *
 * Scope: office + admin only. DriverOS is deliberately out (shared-tablet by
 * design — a different driver on the same shared tablet is not a compromise
 * signal), and is not touched here.
 *
 * This is the regression-catching test: revert the sendNewDeviceLogin call in
 * AdminAuthService.completeLogin and the first assertion fails.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../src/notifications/channels/notification-channel';
import { createTestAdmin, disconnectAdminFixtures, ensureAdminPermissions, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin new-device sign-in notification', () => {
  let app: INestApplication;
  let channel: NotificationChannel;

  beforeAll(async () => {
    await ensureAdminPermissions();
    app = await buildTestApp();
    channel = app.get<NotificationChannel>(NOTIFICATION_CHANNEL);
  });

  afterAll(async () => {
    await app.close();
    await disconnectAdminFixtures();
  });

  const login = (username: string, userAgent: string) =>
    request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .set('User-Agent', userAgent)
      .send({ username, password: TEST_ADMIN_PASSWORD });

  it('emails the admin owner on an unseen device, and stays silent on the same device next time', async () => {
    const admin = await createTestAdmin([]);
    const adminEmail = `${admin.username}@fleethq.internal`;
    const emailSpy = jest.spyOn(channel, 'sendEmail');

    // First login from device A (never seen for this admin) -> alert fires.
    const first = await login(admin.username, 'e2e-admin-device-A').expect(200);
    expect(first.body.status).toBe('authenticated');

    const alerts = () => emailSpy.mock.calls.filter((c) => c[0].to === adminEmail);
    expect(alerts()).toHaveLength(1);
    const call = alerts()[0][0];
    expect(call.subject).toContain('New sign-in');
    // Links to the admin console's own session review/revoke page.
    expect(call.body).toContain('/admin/settings');

    // Second login from the SAME device A -> the ip+userAgent is now on record,
    // so no new-device email is sent.
    emailSpy.mockClear();
    const second = await login(admin.username, 'e2e-admin-device-A').expect(200);
    expect(second.body.status).toBe('authenticated');
    expect(emailSpy.mock.calls.filter((c) => c[0].to === adminEmail)).toHaveLength(0);

    // A genuinely different device (new user-agent) alerts again — proof it's
    // device-scoped, not merely a first-login-only signal.
    emailSpy.mockClear();
    await login(admin.username, 'e2e-admin-device-B').expect(200);
    expect(emailSpy.mock.calls.filter((c) => c[0].to === adminEmail)).toHaveLength(1);

    emailSpy.mockRestore();
  });
});
