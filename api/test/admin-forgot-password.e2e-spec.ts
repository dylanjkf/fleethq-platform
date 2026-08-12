/**
 * Self-service FORGOT-PASSWORD for FleetHQ staff admins — the admin-console
 * mirror of the customer AuthRecoveryService flow (auth.e2e-spec.ts), on a
 * separate user table, token store, and session space.
 *
 * Regression bar (these tests must fail if the safety properties are removed):
 *  - non-enumeration: an unknown identifier gets the SAME 200 and issues no
 *    token / sends no email;
 *  - a real admin gets a single-use, TTL'd, hashed reset token + the email;
 *  - a valid token sets the new password (the admin can then log in) AND
 *    revokes the admin's existing sessions; a SECOND use of the same token
 *    fails (single-use);
 *  - an expired/garbage token is rejected.
 */
import { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { buildTestApp } from './utils/build-test-app';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../src/notifications/channels/notification-channel';
import { createTestAdmin, disconnectAdminFixtures, ensureAdminPermissions, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

const ownerPrisma = new PrismaClient();

/** Pulls the raw reset token out of the last reset email sent to `to`. */
function tokenFromResetEmail(spy: jest.SpyInstance, to: string): string | null {
  const calls = spy.mock.calls.filter((c) => c[0].to === to && /reset your fleethq admin password/i.test(c[0].subject));
  if (calls.length === 0) return null;
  const body = calls[calls.length - 1][0].body as string;
  const match = body.match(/reset-password\?token=([^\s]+)/);
  return match ? match[1] : null;
}

describe('Admin self-service forgot/reset password', () => {
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
    await ownerPrisma.$disconnect();
  });

  const adminEmail = (username: string) => `${username}@fleethq.internal`;

  it('(a) is non-enumerating: an unknown identifier returns 200 and issues no token / sends no email', async () => {
    const emailSpy = jest.spyOn(channel, 'sendEmail');
    const before = await ownerPrisma.adminAuthToken.count();

    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/forgot-password')
      .send({ identifier: 'definitely-not-a-real-admin-xyz' })
      .expect(200);
    expect(res.body).toEqual({ ok: true });

    // No reset email to anyone, and no reset-token row was created anywhere.
    expect(emailSpy.mock.calls.filter((c) => /reset your fleethq admin password/i.test(c[0].subject))).toHaveLength(0);
    const after = await ownerPrisma.adminAuthToken.count();
    expect(after).toBe(before);

    emailSpy.mockRestore();
  });

  it('(b) issues a hashed single-use token and emails the reset link for a real admin', async () => {
    const admin = await createTestAdmin([]);
    const emailSpy = jest.spyOn(channel, 'sendEmail');

    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/forgot-password')
      .send({ identifier: admin.username })
      .expect(200);
    expect(res.body).toEqual({ ok: true });

    // Exactly one reset token row for this admin, stored hash-only (never raw).
    const tokens = await ownerPrisma.adminAuthToken.findMany({ where: { adminUserId: admin.adminUserId } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('PASSWORD_RESET');
    expect(tokens[0].usedAt).toBeNull();
    expect(tokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    const rawToken = tokenFromResetEmail(emailSpy, adminEmail(admin.username));
    expect(rawToken).toBeTruthy();
    // The stored value is the SHA-256 hash of the emailed raw token, not the token itself.
    expect(tokens[0].tokenHash).toBe(createHash('sha256').update(rawToken as string).digest('hex'));
    expect(tokens[0].tokenHash).not.toBe(rawToken);

    emailSpy.mockRestore();
  });

  it('(c) reset sets the new password, revokes existing sessions, and the token is single-use', async () => {
    const admin = await createTestAdmin([]);
    const emailSpy = jest.spyOn(channel, 'sendEmail');

    // Establish a live session BEFORE the reset, and confirm it works.
    const loginBefore = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    const oldToken = loginBefore.body.accessToken as string;
    await request(app.getHttpServer()).get('/v1/admin/auth/me').set('Authorization', `Bearer ${oldToken}`).expect(200);

    // Request + complete the reset.
    await request(app.getHttpServer()).post('/v1/admin/auth/forgot-password').send({ identifier: admin.username }).expect(200);
    const rawToken = tokenFromResetEmail(emailSpy, adminEmail(admin.username));
    expect(rawToken).toBeTruthy();

    const newPassword = 'Brand-New-Admin-Pw-9';
    await request(app.getHttpServer())
      .post('/v1/admin/auth/reset-password')
      .send({ token: rawToken, newPassword })
      .expect(200);

    // The old session is dead (tokenVersion bumped + session row revoked).
    await request(app.getHttpServer()).get('/v1/admin/auth/me').set('Authorization', `Bearer ${oldToken}`).expect(401);

    // The pre-reset session row was actually flipped to revoked (not just the
    // JWT rejected) — checked BEFORE any new login re-creates a live session.
    const liveSessions = await ownerPrisma.adminSession.count({
      where: { adminUserId: admin.adminUserId, revokedAt: null },
    });
    expect(liveSessions).toBe(0);

    // The old password no longer works; the new one does.
    await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: newPassword })
      .expect(200);

    // Single-use: replaying the same token fails.
    await request(app.getHttpServer())
      .post('/v1/admin/auth/reset-password')
      .send({ token: rawToken, newPassword: 'Another-New-Pw-9' })
      .expect(401);

    emailSpy.mockRestore();
  });

  it('(c2) a token is single-use even when the reset itself is rejected (consume burns it up-front)', async () => {
    // Guards the consume()-level single-use marking independently of the
    // post-success invalidateAll: a weak-password attempt is rejected AFTER the
    // token is consumed but BEFORE invalidateAll runs, so replaying the same
    // token with a valid password must still fail. Removing consume's usedAt
    // marking would let the second attempt succeed and break this test.
    const admin = await createTestAdmin([]);
    const emailSpy = jest.spyOn(channel, 'sendEmail');

    await request(app.getHttpServer()).post('/v1/admin/auth/forgot-password').send({ identifier: admin.username }).expect(200);
    const rawToken = tokenFromResetEmail(emailSpy, adminEmail(admin.username));
    expect(rawToken).toBeTruthy();

    // First use: passes DTO length but fails the service strength rule (a single
    // character class) → rejected 400 — but consume() has already burned it.
    await request(app.getHttpServer())
      .post('/v1/admin/auth/reset-password')
      .send({ token: rawToken, newPassword: 'onlylowercaseletters' })
      .expect(400);

    // Replay with a strong password is now rejected because the token is spent.
    await request(app.getHttpServer())
      .post('/v1/admin/auth/reset-password')
      .send({ token: rawToken, newPassword: 'Strong-New-Pw-9' })
      .expect(401);

    // The original password still works — no reset ever completed.
    await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);

    emailSpy.mockRestore();
  });

  it('(d) rejects an expired token and a garbage token', async () => {
    const admin = await createTestAdmin([]);

    // A garbage token nobody ever issued.
    await request(app.getHttpServer())
      .post('/v1/admin/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword: 'Valid-New-Pw-9' })
      .expect(401);

    // A genuinely-issued-shaped token that has already expired.
    const raw = `expired-raw-token-${randomUUID()}`;
    await ownerPrisma.adminAuthToken.create({
      data: {
        adminUserId: admin.adminUserId,
        type: 'PASSWORD_RESET',
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await request(app.getHttpServer())
      .post('/v1/admin/auth/reset-password')
      .send({ token: raw, newPassword: 'Valid-New-Pw-9' })
      .expect(401);
  });
});
