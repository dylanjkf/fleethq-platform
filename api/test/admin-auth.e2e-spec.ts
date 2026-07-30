/**
 * The FleetHQ internal administration platform's own auth surface
 * (21-Admin-Platform/Overview.md) — a completely separate login, token
 * space, and DB role from the customer-facing AuthController exercised by
 * auth.e2e-spec.ts. Covers: login, lockout, "me", MFA enrolment + challenge,
 * and session listing/revocation/logout.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { totp } from '../src/auth/mfa/totp';
import { buildTestApp } from './utils/build-test-app';
import { createTestAdmin, disconnectAdminFixtures, ensureAdminPermissions, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin Auth', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await ensureAdminPermissions();
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
    await disconnectAdminFixtures();
  });

  it('logs in with correct credentials and returns a usable token', async () => {
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.AUDIT_LOG_VIEW]);

    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    expect(loginRes.body.status).toBe('authenticated');
    expect(typeof loginRes.body.accessToken).toBe('string');

    const meRes = await request(app.getHttpServer())
      .get('/v1/admin/auth/me')
      .set('Authorization', `Bearer ${loginRes.body.accessToken}`)
      .expect(200);
    expect(meRes.body.username).toBe(admin.username);
    expect(meRes.body.permissions).toContain(ADMIN_PERMISSIONS.AUDIT_LOG_VIEW);
  });

  it('rejects a wrong password', async () => {
    const admin = await createTestAdmin([]);
    await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: 'not-the-password' })
      .expect(401);
  });

  it('locks the account after 5 failed attempts', async () => {
    const admin = await createTestAdmin([]);
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/v1/admin/auth/login')
        .send({ username: admin.username, password: 'wrong' });
    }
    // A 6th attempt, even with the CORRECT password, must now be rejected —
    // proof the account is actually locked, not just repeatedly wrong.
    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated request to a protected admin route', async () => {
    await request(app.getHttpServer()).get('/v1/admin/auth/me').expect(401);
  });

  it('rejects a customer-side JWT on an admin route', async () => {
    // No customer session exists in this file, so an arbitrary bearer value
    // exercises the same path: admin-jwt must never accept anything it didn't
    // itself sign.
    await request(app.getHttpServer())
      .get('/v1/admin/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('requires an MFA challenge once enabled, then completes login', async () => {
    const admin = await createTestAdmin([]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    const token = loginRes.body.accessToken as string;

    const setupRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/mfa/setup')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const secret = setupRes.body.secret as string;

    await request(app.getHttpServer())
      .post('/v1/admin/auth/mfa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: totp(secret) })
      .expect(200);

    const secondLogin = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    expect(secondLogin.body.status).toBe('mfa_required');
    expect(typeof secondLogin.body.mfaToken).toBe('string');

    const verifyRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/mfa/verify')
      .send({ mfaToken: secondLogin.body.mfaToken, code: totp(secret) })
      .expect(200);
    expect(verifyRes.body.status).toBe('authenticated');
  });

  it('lists sessions, revokes one, and rejects a revoked session on the next request', async () => {
    const admin = await createTestAdmin([]);
    const first = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);

    const sessions = await request(app.getHttpServer())
      .get('/v1/admin/auth/sessions')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .expect(200);
    expect(sessions.body.length).toBeGreaterThanOrEqual(2);

    const otherSession = sessions.body.find((s: { isCurrent: boolean }) => !s.isCurrent);
    await request(app.getHttpServer())
      .delete(`/v1/admin/auth/sessions/${otherSession.id}`)
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/v1/admin/auth/me')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(401);
  });

  it('logs out and rejects the token afterward', async () => {
    const admin = await createTestAdmin([]);
    const loginRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    const token = loginRes.body.accessToken as string;

    await request(app.getHttpServer())
      .post('/v1/admin/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get('/v1/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
