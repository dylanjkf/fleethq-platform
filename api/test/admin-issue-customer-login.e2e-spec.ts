/**
 * Admin "issue a new customer login" (AdminOrganisationsController.createOrganisation):
 * a FleetHQ staff admin provisions a brand-new customer org + its first
 * Administrator login with a one-time temporary password, and that account is
 * forced to change the password before it can be used.
 *
 * Proves the four things that matter: (1) a login is issued and the temporary
 * password is returned once, (2) the account must change its password on first
 * sign-in, (3) the endpoint is unreachable without admin auth, and (4) it's
 * gated by the organisations:create admin permission.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ADMIN_PERMISSIONS, type AdminPermissionKey } from '../src/common/permissions/admin-permission-catalog';
import { totp } from '../src/auth/mfa/totp';
import { buildTestApp } from './utils/build-test-app';
import { disconnectFixtures, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, ensureAdminPermissions, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

describe('Admin: issue a new customer login', () => {
  let app: INestApplication;
  let adminToken: string;
  const http = () => request(app.getHttpServer());

  let emailCounter = 0;
  const uniqueEmail = () => `owner-${Date.now()}-${emailCounter++}@example.com`;

  async function adminTokenFor(permissions: AdminPermissionKey[]): Promise<string> {
    const admin = await createTestAdmin(permissions);
    const login = await http()
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    return login.body.accessToken as string;
  }

  beforeAll(async () => {
    await ensurePermissions();
    await ensureAdminPermissions();
    app = await buildTestApp();
    adminToken = await adminTokenFor([ADMIN_PERMISSIONS.ORGANISATIONS_CREATE]);
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  it('is unreachable without an admin token', async () => {
    await http().post('/v1/admin/organisations').send({ companyName: 'No Auth Co', adminEmail: uniqueEmail() }).expect(401);
  });

  it('is forbidden for an admin lacking organisations:create', async () => {
    const weakToken = await adminTokenFor([ADMIN_PERMISSIONS.ORGANISATIONS_VIEW]);
    await http()
      .post('/v1/admin/organisations')
      .set('Authorization', `Bearer ${weakToken}`)
      .send({ companyName: 'Weak Admin Co', adminEmail: uniqueEmail() })
      .expect(403);
  });

  it('issues a login, forces a password change on first sign-in, then authenticates', async () => {
    const email = uniqueEmail();

    const created = await http()
      .post('/v1/admin/organisations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'Acme Freight', adminEmail: email })
      .expect(201);
    expect(created.body.username).toBe(email);
    expect(created.body.companyId).toBeTruthy();
    const tempPassword = created.body.temporaryPassword as string;
    expect(typeof tempPassword).toBe('string');
    expect(tempPassword.length).toBeGreaterThanOrEqual(20);

    // First sign-in with the temporary credential can't produce a session on its
    // own — the account is blocked pending a password change (and, if the org
    // also forces MFA, an MFA setup first). Either way it's never "authenticated".
    const first = await http().post('/v1/auth/login').send({ username: email, password: tempPassword }).expect(200);
    expect(first.body.status).not.toBe('authenticated');
    expect(['password_expired', 'mfa_setup_required']).toContain(first.body.status);

    // If MFA setup is demanded first, satisfy it — the must-change block then
    // surfaces next.
    let changeToken: string | undefined = first.body.changeToken;
    if (first.body.status === 'mfa_setup_required') {
      const begin = await http().post('/v1/auth/mfa-setup/begin').send({ setupToken: first.body.setupToken }).expect(200);
      const afterMfa = await http()
        .post('/v1/auth/mfa-setup/confirm')
        .send({ setupToken: first.body.setupToken, code: totp(begin.body.secret) })
        .expect(200);
      expect(afterMfa.body.status).toBe('password_expired');
      changeToken = afterMfa.body.changeToken;
    }
    expect(typeof changeToken).toBe('string');

    // The forced password change clears the must-change flag and hands back a
    // real session.
    const done = await http()
      .post('/v1/auth/password-expired/change')
      .send({ changeToken, newPassword: 'Brand-New-Pass-9!' })
      .expect(200);
    expect(done.body.status).toBe('authenticated');
    expect(done.body.accessToken).toBeTruthy();

    // The temporary password is now dead.
    await http().post('/v1/auth/login').send({ username: email, password: tempPassword }).expect(401);
  });

  it('rejects a duplicate email with a clear conflict', async () => {
    const email = uniqueEmail();
    await http().post('/v1/admin/organisations').set('Authorization', `Bearer ${adminToken}`).send({ companyName: 'First Co', adminEmail: email }).expect(201);
    const dup = await http()
      .post('/v1/admin/organisations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'Second Co', adminEmail: email })
      .expect(409);
    expect(dup.body.error.code).toBe('EMAIL_IN_USE');
  });

  it('rejects a malformed email address', async () => {
    await http()
      .post('/v1/admin/organisations')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ companyName: 'Bad Email Co', adminEmail: 'not-an-email' })
      .expect(400);
  });
});
