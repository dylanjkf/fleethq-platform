/**
 * Auth/Billing Platform Phase 10 (security hardening depth): a concurrent-
 * session cap so one account can't accumulate unlimited live sessions, and
 * the server-side fallback that makes the new-device-login alert meaningful
 * even for a client that never sends a `deviceFingerprint` (previously that
 * silently skipped the alert every time — see AuthSessionsService.hasKnownIpUserAgent).
 * Session revocation from password-change/MFA-enable/disable is covered in
 * auth-security-policy.e2e-spec.ts and mfa.e2e-spec.ts respectively.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { AuthSessionsService } from '../src/auth/auth-sessions.service';
import { AuthMailService } from '../src/auth/auth-mail.service';

const ownerPrisma = new PrismaClient();

describe('Auth/Billing Platform Phase 10: session hardening', () => {
  let app: INestApplication;
  let sessions: AuthSessionsService;
  let mail: AuthMailService;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
    sessions = app.get(AuthSessionsService);
    mail = app.get(AuthMailService);
  });
  afterAll(async () => {
    await app.close();
    await ownerPrisma.$disconnect();
    await disconnectFixtures();
  });

  const http = () => request(app.getHttpServer());
  const login = (username: string) => http().post('/v1/auth/login').send({ username, password: TEST_PASSWORD });

  it('caps concurrent sessions per account, evicting the oldest first', async () => {
    const tenant = await createTestTenant([]);
    const tokens: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await login(tenant.username).expect(200);
      tokens.push(res.body.accessToken as string);
    }

    // The 11th login pushed the account over the 10-session cap — the very
    // first session issued is evicted, everything since stays alive.
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokens[0]}`).expect(401);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokens[1]}`).expect(200);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokens[10]}`).expect(200);

    const list = await http().get('/v1/auth/sessions').set('Authorization', `Bearer ${tokens[10]}`).expect(200);
    expect(list.body.length).toBeLessThanOrEqual(10);
  });

  it('hasKnownIpUserAgent recognises a previously-seen IP+user-agent pair for that user, and rejects an unseen one', async () => {
    const tenant = await createTestTenant([]);
    const auth = await login(tenant.username).expect(200);
    const me = await http().get('/v1/auth/me').set('Authorization', `Bearer ${auth.body.accessToken}`).expect(200);
    const userId = (me.body.userId ?? me.body.id) as string;
    const membership = await ownerPrisma.companyMembership.findFirstOrThrow({ where: { userId, companyId: tenant.companyId } });

    // Seed a session row directly — the test harness doesn't run behind a
    // proxy, so there's no way to make a real request arrive with a chosen
    // client IP; this exercises the same stored ipAddress/userAgent columns
    // a real login would write.
    await ownerPrisma.userSession.create({
      data: {
        userId,
        companyId: tenant.companyId,
        membershipId: membership.id,
        ipAddress: '203.0.113.9',
        userAgent: 'phase10-test-agent',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(sessions.hasKnownIpUserAgent(userId, '203.0.113.9', 'phase10-test-agent')).resolves.toBe(true);
    await expect(sessions.hasKnownIpUserAgent(userId, '203.0.113.250', 'phase10-test-agent')).resolves.toBe(false);
    await expect(sessions.hasKnownIpUserAgent(userId, null, null)).resolves.toBe(false);
  });

  it('hasSeenDeviceFingerprint recognises a device from a prior login of this user (A3)', async () => {
    const tenant = await createTestTenant([]);
    // A first login carrying a device fingerprint records it (hashed) on the session.
    const auth = await http().post('/v1/auth/login').send({ username: tenant.username, password: TEST_PASSWORD, deviceFingerprint: 'tablet-fp-1' }).expect(200);
    const me = await http().get('/v1/auth/me').set('Authorization', `Bearer ${auth.body.accessToken}`).expect(200);
    const userId = (me.body.userId ?? me.body.id) as string;

    // The same fingerprint is now "seen"; an unseen one is not — and it never
    // grants trusted-device (MFA-skip) status, only settles the alert decision.
    await expect(sessions.hasSeenDeviceFingerprint(userId, 'tablet-fp-1')).resolves.toBe(true);
    await expect(sessions.hasSeenDeviceFingerprint(userId, 'a-different-tablet')).resolves.toBe(false);
    await expect(sessions.isDeviceTrusted(userId, 'tablet-fp-1')).resolves.toBe(false);
  });

  it('does NOT re-send a new-device email when a driver logs in again from the SAME device (A3 — no per-shift spam)', async () => {
    const tenant = await createTestTenant([]);
    // The new-device email only fires for a user with an email on file.
    await ownerPrisma.user.update({ where: { id: tenant.userId }, data: { email: 'driver@example.test' } });
    const spy = jest.spyOn(mail, 'sendNewDeviceLogin');

    // Shift 1 on a new tablet → genuinely new account-device pairing → alert.
    await http().post('/v1/auth/login').send({ username: tenant.username, password: TEST_PASSWORD, deviceFingerprint: 'shift-tablet' }).expect(200);
    expect(spy.mock.calls.filter((c) => c[0] === 'driver@example.test')).toHaveLength(1);

    spy.mockClear();
    // Shift 2 on the SAME tablet (different IP would be irrelevant now) → known
    // device → NO alert. Previously this fired every shift via the IP/UA fallback.
    await http().post('/v1/auth/login').send({ username: tenant.username, password: TEST_PASSWORD, deviceFingerprint: 'shift-tablet' }).expect(200);
    expect(spy.mock.calls.filter((c) => c[0] === 'driver@example.test')).toHaveLength(0);

    spy.mockRestore();
  });
});
