/**
 * Multi-factor authentication (TOTP): enrol, then prove login demands a second
 * factor, that a wrong code is refused, that a valid TOTP and a single-use
 * backup code each complete the login, and that disabling MFA returns the
 * account to single-factor. Codes are generated with the same RFC 6238 routine
 * the server verifies against.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { totp } from '../src/auth/mfa/totp';

describe('MFA (TOTP)', () => {
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

  const http = () => request(app.getHttpServer());
  const login = (username: string) => http().post('/v1/auth/login').send({ username, password: TEST_PASSWORD });

  async function enrol(auth: string): Promise<{ secret: string; backupCodes: string[] }> {
    const setup = await http().post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${auth}`).expect(200);
    const secret = setup.body.secret as string;
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/');
    const enable = await http()
      .post('/v1/auth/mfa/enable')
      .set('Authorization', `Bearer ${auth}`)
      .send({ code: totp(secret) })
      .expect(200);
    expect(Array.isArray(enable.body.backupCodes)).toBe(true);
    expect(enable.body.backupCodes).toHaveLength(10);
    return { secret, backupCodes: enable.body.backupCodes };
  }

  it('enrols, then requires and verifies a TOTP second factor at login', async () => {
    const tenant = await createTestTenant([]);
    const first = await login(tenant.username).expect(200);
    expect(first.body.status).toBe('authenticated'); // single factor before enrolment
    const { secret } = await enrol(first.body.accessToken);

    // Now login stops at the MFA challenge — no session token yet.
    const challenge = await login(tenant.username).expect(200);
    expect(challenge.body.status).toBe('mfa_required');
    expect(challenge.body.mfaToken).toBeTruthy();
    expect(challenge.body.accessToken).toBeUndefined();

    // Wrong code is refused.
    await http().post('/v1/auth/mfa/verify').send({ mfaToken: challenge.body.mfaToken, code: '000000' }).expect(401);

    // Correct code completes the login.
    const done = await http()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: challenge.body.mfaToken, code: totp(secret) })
      .expect(200);
    expect(done.body.status).toBe('authenticated');
    expect(done.body.accessToken).toBeTruthy();

    // getMe reflects the enrolled state.
    const me = await http().get('/v1/auth/me').set('Authorization', `Bearer ${done.body.accessToken}`).expect(200);
    expect(me.body.mfaEnabled).toBe(true);
  });

  it('accepts a space-grouped TOTP code at the login challenge ("123 456")', async () => {
    const tenant = await createTestTenant([]);
    const first = await login(tenant.username).expect(200);
    const { secret } = await enrol(first.body.accessToken);

    const challenge = await login(tenant.username).expect(200);
    expect(challenge.body.status).toBe('mfa_required');

    // Authenticator apps show the code grouped; a user may paste "123 456".
    const raw = totp(secret);
    const spaced = `${raw.slice(0, 3)} ${raw.slice(3)}`;
    expect(spaced).toContain(' ');
    const done = await http()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: challenge.body.mfaToken, code: spaced })
      .expect(200);
    expect(done.body.status).toBe('authenticated');
    expect(done.body.accessToken).toBeTruthy();
  });

  it('accepts a single-use backup code and then rejects its reuse', async () => {
    const tenant = await createTestTenant([]);
    const initial = await login(tenant.username).expect(200);
    const { backupCodes } = await enrol(initial.body.accessToken);
    const code = backupCodes[0];

    const c1 = await login(tenant.username).expect(200);
    const ok = await http().post('/v1/auth/mfa/verify').send({ mfaToken: c1.body.mfaToken, code }).expect(200);
    expect(ok.body.status).toBe('authenticated');

    // The same backup code cannot be used twice.
    const c2 = await login(tenant.username).expect(200);
    await http().post('/v1/auth/mfa/verify').send({ mfaToken: c2.body.mfaToken, code }).expect(401);
  });

  it('disables MFA (with a valid code) and returns to single-factor login', async () => {
    const tenant = await createTestTenant([]);
    const initial = await login(tenant.username).expect(200);
    const { secret } = await enrol(initial.body.accessToken);

    const challenge = await login(tenant.username).expect(200);
    const session = await http()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: challenge.body.mfaToken, code: totp(secret) })
      .expect(200);

    await http()
      .post('/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${session.body.accessToken}`)
      .send({ code: totp(secret) })
      .expect(200);

    const after = await login(tenant.username).expect(200);
    expect(after.body.status).toBe('authenticated'); // single factor again
  });

  it('enabling MFA revokes other active sessions (Auth/Billing Platform Phase 10), but not the one enrolling', async () => {
    const tenant = await createTestTenant([]);
    const deviceA = await login(tenant.username).expect(200);
    const deviceB = await login(tenant.username).expect(200);
    const tokenA = deviceA.body.accessToken as string;
    const tokenB = deviceB.body.accessToken as string;

    await enrol(tokenA);

    // The enrolling session still works; the other device is signed out.
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenA}`).expect(200);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`).expect(401);
  });

  it('disabling MFA revokes other active sessions, but not the one disabling it', async () => {
    const tenant = await createTestTenant([]);
    const initial = await login(tenant.username).expect(200);
    const { secret } = await enrol(initial.body.accessToken);

    // A second device completes the MFA challenge to get its own session.
    const challengeB = await login(tenant.username).expect(200);
    const deviceB = await http()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: challengeB.body.mfaToken, code: totp(secret) })
      .expect(200);
    const tokenB = deviceB.body.accessToken as string;

    // A third device (the one that will disable MFA).
    const challengeC = await login(tenant.username).expect(200);
    const deviceC = await http()
      .post('/v1/auth/mfa/verify')
      .send({ mfaToken: challengeC.body.mfaToken, code: totp(secret) })
      .expect(200);
    const tokenC = deviceC.body.accessToken as string;

    await http().post('/v1/auth/mfa/disable').set('Authorization', `Bearer ${tokenC}`).send({ code: totp(secret) }).expect(200);

    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenC}`).expect(200);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`).expect(401);
  });
});
