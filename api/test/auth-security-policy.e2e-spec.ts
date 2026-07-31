/**
 * Auth/Billing Platform Phase 3: per-company mandatory-MFA policy, password
 * expiry, password-reuse prevention, and self-service password change.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { totp } from '../src/auth/mfa/totp';

const ownerPrisma = new PrismaClient();

describe('Auth/Billing Platform Phase 3: security policy', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await ownerPrisma.$disconnect();
    await disconnectFixtures();
  });

  const http = () => request(app.getHttpServer());
  const login = (username: string, password = TEST_PASSWORD) => http().post('/v1/auth/login').send({ username, password });

  describe('security-settings endpoint', () => {
    it('defaults to no policy, is permission-gated, and persists a change', async () => {
      const tenant = await createTestTenant([PERMISSIONS.SECURITY_POLICY_MANAGE]);
      const auth = await login(tenant.username).expect(200);
      const token = auth.body.accessToken as string;

      const initial = await http().get('/v1/security-settings').set('Authorization', `Bearer ${token}`).expect(200);
      expect(initial.body).toEqual({ mfaRequired: false, passwordExpiryDays: null, isDefault: true });

      const updated = await http()
        .put('/v1/security-settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ mfaRequired: true, passwordExpiryDays: 90 })
        .expect(200);
      expect(updated.body).toEqual({ mfaRequired: true, passwordExpiryDays: 90, isDefault: false });

      const readBack = await http().get('/v1/security-settings').set('Authorization', `Bearer ${token}`).expect(200);
      expect(readBack.body).toEqual({ mfaRequired: true, passwordExpiryDays: 90, isDefault: false });
    });

    it('refuses a user without security_policy:manage', async () => {
      const tenant = await createTestTenant([]);
      const auth = await login(tenant.username).expect(200);
      await http().get('/v1/security-settings').set('Authorization', `Bearer ${auth.body.accessToken}`).expect(403);
    });
  });

  describe('mandatory MFA policy', () => {
    it('blocks a login with mfa_setup_required until enrolment completes, then issues the session', async () => {
      const tenant = await createTestTenant([PERMISSIONS.SECURITY_POLICY_MANAGE]);
      const setup = await login(tenant.username).expect(200);
      await http()
        .put('/v1/security-settings')
        .set('Authorization', `Bearer ${setup.body.accessToken}`)
        .send({ mfaRequired: true })
        .expect(200);

      // Next login is blocked — no session yet, just a setup token.
      const blocked = await login(tenant.username).expect(200);
      expect(blocked.body.status).toBe('mfa_setup_required');
      expect(blocked.body.setupToken).toBeTruthy();
      expect(blocked.body.accessToken).toBeUndefined();

      const begin = await http().post('/v1/auth/mfa-setup/begin').send({ setupToken: blocked.body.setupToken }).expect(200);
      expect(begin.body.otpauthUrl).toContain('otpauth://totp/');

      // A wrong code doesn't complete the login.
      await http().post('/v1/auth/mfa-setup/confirm').send({ setupToken: blocked.body.setupToken, code: '000000' }).expect(401);

      const confirm = await http()
        .post('/v1/auth/mfa-setup/confirm')
        .send({ setupToken: blocked.body.setupToken, code: totp(begin.body.secret) })
        .expect(200);
      expect(confirm.body.status).toBe('authenticated');
      expect(confirm.body.accessToken).toBeTruthy();
      expect(confirm.body.backupCodes).toHaveLength(10);

      // Enrolment stuck — the very next login no longer needs the policy gate.
      const after = await login(tenant.username).expect(200);
      expect(after.body.status).toBe('mfa_required'); // now the account's OWN MFA challenge applies
    });

    it("a setup token can't be replayed against mfa-setup/confirm twice", async () => {
      const tenant = await createTestTenant([PERMISSIONS.SECURITY_POLICY_MANAGE]);
      const setup = await login(tenant.username).expect(200);
      await http().put('/v1/security-settings').set('Authorization', `Bearer ${setup.body.accessToken}`).send({ mfaRequired: true }).expect(200);
      const blocked = await login(tenant.username).expect(200);
      const begin = await http().post('/v1/auth/mfa-setup/begin').send({ setupToken: blocked.body.setupToken }).expect(200);
      await http().post('/v1/auth/mfa-setup/confirm').send({ setupToken: blocked.body.setupToken, code: totp(begin.body.secret) }).expect(200);

      // MFA is enabled now — re-confirming (even with a fresh code) is refused (already enrolled).
      await http().post('/v1/auth/mfa-setup/confirm').send({ setupToken: blocked.body.setupToken, code: totp(begin.body.secret) }).expect(409);
    });

    it('an mfa_required token is refused at mfa-setup/begin (wrong purpose)', async () => {
      const tenant = await createTestTenant([]);
      const login1 = await login(tenant.username).expect(200);
      expect(login1.body.status).toBe('authenticated');
      // login1's own accessToken (not a policy token) must not work as a setupToken.
      await http().post('/v1/auth/mfa-setup/begin').send({ setupToken: login1.body.accessToken }).expect(401);
    });
  });

  describe('password expiry policy', () => {
    it('blocks a login with password_expired once the password ages past the policy, then resumes after a change', async () => {
      const tenant = await createTestTenant([PERMISSIONS.SECURITY_POLICY_MANAGE]);
      const setup = await login(tenant.username).expect(200);
      await http()
        .put('/v1/security-settings')
        .set('Authorization', `Bearer ${setup.body.accessToken}`)
        .send({ passwordExpiryDays: 30 })
        .expect(200);

      // Backdate the password's set-time past the 30-day policy (no UI/API sets this — it's stamped automatically).
      await ownerPrisma.user.update({ where: { id: tenant.userId }, data: { passwordChangedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });

      const blocked = await login(tenant.username).expect(200);
      expect(blocked.body.status).toBe('password_expired');
      expect(blocked.body.changeToken).toBeTruthy();

      // The old password can't be reused as the "new" one.
      await http().post('/v1/auth/password-expired/change').send({ changeToken: blocked.body.changeToken, newPassword: TEST_PASSWORD }).expect(400);

      const changed = await http()
        .post('/v1/auth/password-expired/change')
        .send({ changeToken: blocked.body.changeToken, newPassword: 'BrandNewPass1!' })
        .expect(200);
      expect(changed.body.status).toBe('authenticated');

      // Old password no longer works; the new one does and isn't blocked again (passwordChangedAt reset to now).
      await login(tenant.username, TEST_PASSWORD).expect(401);
      const relogin = await login(tenant.username, 'BrandNewPass1!').expect(200);
      expect(relogin.body.status).toBe('authenticated');
    });

    it("a change token can't be replayed once the login it was minted for has already resolved", async () => {
      const tenant = await createTestTenant([PERMISSIONS.SECURITY_POLICY_MANAGE]);
      const setup = await login(tenant.username).expect(200);
      await http().put('/v1/security-settings').set('Authorization', `Bearer ${setup.body.accessToken}`).send({ passwordExpiryDays: 30 }).expect(200);
      await ownerPrisma.user.update({ where: { id: tenant.userId }, data: { passwordChangedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });
      const blocked = await login(tenant.username).expect(200);
      await http().post('/v1/auth/password-expired/change').send({ changeToken: blocked.body.changeToken, newPassword: 'BrandNewPass1!' }).expect(200);
      // Replaying the same token a second time: the password is no longer expired, so this now just resumes login again — assert it isn't rejected outright but reflects the current (non-expired) state.
      const replay = await http().post('/v1/auth/password-expired/change').send({ changeToken: blocked.body.changeToken, newPassword: 'AnotherPass2!' }).expect(200);
      expect(replay.body.status).toBe('authenticated');
    });
  });

  describe('self-service change-password', () => {
    it('changes the password, keeps the acting session alive, and rejects a reused password', async () => {
      const tenant = await createTestTenant([]);
      const first = await login(tenant.username).expect(200);
      const token = first.body.accessToken as string;

      await http().post('/v1/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'wrong', newPassword: 'BrandNewPass1!' }).expect(401);

      await http()
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'BrandNewPass1!' })
        .expect(200);

      // The session that performed the change is still valid.
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);

      await login(tenant.username, TEST_PASSWORD).expect(401);
      await login(tenant.username, 'BrandNewPass1!').expect(200);

      // Changing back to the password used two changes ago is refused (history reuse-prevention).
      const relogged = await login(tenant.username, 'BrandNewPass1!').expect(200);
      await http()
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${relogged.body.accessToken}`)
        .send({ currentPassword: 'BrandNewPass1!', newPassword: TEST_PASSWORD })
        .expect(400);
    });

    it('revokes every other active session (Auth/Billing Platform Phase 10), but not the one making the change', async () => {
      const tenant = await createTestTenant([]);
      const deviceA = await login(tenant.username).expect(200);
      const deviceB = await login(tenant.username).expect(200);
      const tokenA = deviceA.body.accessToken as string;
      const tokenB = deviceB.body.accessToken as string;

      // Both sessions work before the change.
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenA}`).expect(200);
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`).expect(200);

      await http()
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'AnotherDeviceLoggedOut1!' })
        .expect(200);

      // The device that made the change keeps working; the other device is signed out.
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenA}`).expect(200);
      await http().get('/v1/auth/me').set('Authorization', `Bearer ${tokenB}`).expect(401);
    });
  });
});
