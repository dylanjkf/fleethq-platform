/**
 * A2 auth completeness: email verification, password reset, and brute-force
 * login lockout. Tokens are minted through the app's own AuthTokensService
 * (the DB stores only their hash, so a test can't read a raw token back), then
 * redeemed over HTTP exactly as a user clicking an emailed link would.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { AuthTokensService } from '../src/auth/auth-tokens.service';

const ownerPrisma = new PrismaClient();

describe('Auth completeness (verify, reset, lockout)', () => {
  let app: INestApplication;
  let tokens: AuthTokensService;
  let suffix = 0;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
    tokens = app.get(AuthTokensService);
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function signup(email?: string) {
    suffix += 1;
    const username = `owner-${Date.now()}-${suffix}`;
    const res = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({ companyName: `Co ${username}`, adminUsername: username, adminPassword: 'test-password-123', adminFullName: 'Ada Owner', adminEmail: email })
      .expect(201);
    expect(res.body.status).toBe('authenticated');
    const user = await ownerPrisma.user.findUniqueOrThrow({ where: { username } });
    return { username, userId: user.id };
  }

  function login(username: string, password: string) {
    return request(app.getHttpServer()).post('/v1/auth/login').send({ username, password });
  }

  it('verifies an email via a token link', async () => {
    const { userId } = await signup('ada@example.com');
    let user = await ownerPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.emailVerifiedAt).toBeNull();

    const token = await tokens.issue(userId, 'EMAIL_VERIFY');
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token }).expect(200);

    user = await ownerPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.emailVerifiedAt).not.toBeNull();

    // A replayed (already-used) token is rejected.
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token }).expect(401);
  });

  it('resets a password: forgot returns ok without enumerating, and a token sets a new password', async () => {
    const { username, userId } = await signup('reset@example.com');

    // Never reveals whether an account exists.
    await request(app.getHttpServer()).post('/v1/auth/forgot-password').send({ identifier: 'reset@example.com' }).expect(200);
    await request(app.getHttpServer()).post('/v1/auth/forgot-password').send({ identifier: 'nobody@nowhere.test' }).expect(200);
    const created = await ownerPrisma.authToken.findFirst({ where: { userId, type: 'PASSWORD_RESET' } });
    expect(created).not.toBeNull();

    const token = await tokens.issue(userId, 'PASSWORD_RESET');
    await request(app.getHttpServer()).post('/v1/auth/reset-password').send({ token, newPassword: 'brandNewPass1' }).expect(200);

    await login(username, 'brandNewPass1').expect(200);
    await login(username, 'test-password-123').expect(401); // old password no longer works

    // The reset token is single-use.
    await request(app.getHttpServer()).post('/v1/auth/reset-password').send({ token, newPassword: 'again12345' }).expect(401);
  });

  it('rejects an invalid reset token', async () => {
    await request(app.getHttpServer()).post('/v1/auth/reset-password').send({ token: 'not-a-real-token', newPassword: 'whatever12' }).expect(401);
  });

  it('revokes existing sessions when the password is reset (tokenVersion)', async () => {
    const username = `revoke-${Date.now()}`;
    const signupRes = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({ companyName: `Co ${username}`, adminUsername: username, adminPassword: 'test-password-123', adminFullName: 'Rev Oke', adminEmail: 'revoke@example.com' })
      .expect(201);
    const oldToken = signupRes.body.accessToken as string;
    const userId = (await ownerPrisma.user.findUniqueOrThrow({ where: { username } })).id;

    // The freshly-issued session works.
    await request(app.getHttpServer()).get('/v1/auth/me').set('Authorization', `Bearer ${oldToken}`).expect(200);

    // Reset the password → tokenVersion bumps → the old session is revoked.
    const token = await tokens.issue(userId, 'PASSWORD_RESET');
    await request(app.getHttpServer()).post('/v1/auth/reset-password').send({ token, newPassword: 'brandNewPass1' }).expect(200);

    const revoked = await request(app.getHttpServer()).get('/v1/auth/me').set('Authorization', `Bearer ${oldToken}`).expect(401);
    expect(revoked.body.error.code).toBe('TOKEN_REVOKED');

    // A fresh login mints a token that carries the new version and works again.
    const relog = await login(username, 'brandNewPass1').expect(200);
    await request(app.getHttpServer()).get('/v1/auth/me').set('Authorization', `Bearer ${relog.body.accessToken as string}`).expect(200);
  });

  it('locks an account after repeated failed logins', async () => {
    const { username, userId } = await signup('lock@example.com');
    for (let i = 0; i < 5; i += 1) {
      await login(username, 'wrong-password').expect(401);
    }
    const locked = await ownerPrisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(locked.lockedUntil).not.toBeNull();

    // Even the correct password is refused while locked.
    await login(username, 'test-password-123').expect(401);
  });
});
