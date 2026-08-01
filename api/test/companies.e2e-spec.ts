/**
 * POST /v1/companies is the only endpoint in the whole API that creates a
 * tenant from nothing, so it gets its own coverage distinct from the
 * tenant-isolation/permission specs, which all assume a tenant already
 * exists. Not linked from the product's public UI (no self-service
 * signup/free-trial — see fleethq-frontend's ContactPage) but kept for
 * direct/internal provisioning.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Company signup', () => {
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

  it('creates a company and its admin user, and logs them straight in', async () => {
    const suffix = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `Signup Test Co ${suffix}`,
        adminUsername: `signup-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'Signup Admin',
        acceptedTerms: true,
      })
      .expect(201);

    expect(res.body.status).toBe('authenticated');
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.company.name).toBe(`Signup Test Co ${suffix}`);
    const token = res.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/v1/companies/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.name).toBe(`Signup Test Co ${suffix}`);

    // Proves the Administrator role template was actually attached with real
    // permissions, not just created as an empty shell.
    await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'First Truck' })
      .expect(201);

    // Auth/Billing Platform Phase 4's named role templates: every one of
    // them, not just Administrator/Read Only, should exist from day one.
    const roles = await request(app.getHttpServer())
      .get('/v1/roles?pageSize=100')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const roleNames = roles.body.items.map((r: { name: string }) => r.name);
    expect(roleNames).toEqual(
      expect.arrayContaining(['Administrator', 'Read Only', 'Driver', 'Dispatcher', 'Fleet/Workshop Manager', 'Compliance Officer', 'Accounts']),
    );
  });

  it('rejects signup that has not accepted the Terms of Service/Privacy Policy', async () => {
    const suffix = randomUUID();
    const base = {
      companyName: `No Terms Co ${suffix}`,
      adminUsername: `no-terms-admin-${suffix}`,
      adminPassword: 'a-strong-password',
      adminFullName: 'No Terms Admin',
    };

    await request(app.getHttpServer()).post('/v1/companies').send(base).expect(400);
    await request(app.getHttpServer())
      .post('/v1/companies')
      .send({ ...base, acceptedTerms: false })
      .expect(400);
  });

  it('rejects signup with an invalid ABN, and accepts registration-depth fields with a valid one', async () => {
    const suffix = randomUUID();
    await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `Bad ABN Co ${suffix}`,
        adminUsername: `bad-abn-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'Bad ABN Admin',
        acceptedTerms: true,
        abn: '53004085617', // one digit off a real, checksum-valid ABN
      })
      .expect(400);

    const res = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `Good ABN Co ${suffix}`,
        adminUsername: `good-abn-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'Good ABN Admin',
        acceptedTerms: true,
        abn: '53 004 085 616',
        industry: 'Courier & parcel delivery',
        phone: '1300 555 111',
        fleetSizeEstimate: 12,
      })
      .expect(201);
    const token = res.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get('/v1/companies/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.abn).toBe('53 004 085 616');
    expect(me.body.industry).toBe('Courier & parcel delivery');
    expect(me.body.phone).toBe('1300 555 111');
    expect(me.body.fleetSizeEstimate).toBe(12);
    expect(me.body.termsAcceptedAt).toEqual(expect.any(String));
  });

  it('can update the registration-depth fields after signup', async () => {
    const suffix = randomUUID();
    const signup = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `Update Depth Co ${suffix}`,
        adminUsername: `update-depth-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'Update Depth Admin',
        acceptedTerms: true,
      })
      .expect(201);
    const token = signup.body.accessToken as string;

    const updated = await request(app.getHttpServer())
      .patch('/v1/companies/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ abn: '53004085616', industry: 'Furniture removals', phone: '02 5555 0100', fleetSizeEstimate: 5 })
      .expect(200);
    expect(updated.body.abn).toBe('53004085616');
    expect(updated.body.industry).toBe('Furniture removals');
    expect(updated.body.phone).toBe('02 5555 0100');
    expect(updated.body.fleetSizeEstimate).toBe(5);
  });

  it('does not grant a free trial on signup', async () => {
    const suffix = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `No Trial Co ${suffix}`,
        adminUsername: `no-trial-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'No Trial Admin',
        acceptedTerms: true,
      })
      .expect(201);
    const token = res.body.accessToken as string;

    const ent = await request(app.getHttpServer())
      .get('/v1/billing/entitlements')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(ent.body.trialActive).toBe(false);
    expect(ent.body.trialEndsAt).toBeNull();
    expect(ent.body.trialDaysLeft).toBeNull();
  });

  it('rejects signup when the admin username is already taken', async () => {
    const suffix = randomUUID();
    const body = {
      companyName: `Dup Test Co ${suffix}`,
      adminUsername: `dup-admin-${suffix}`,
      adminPassword: 'a-strong-password',
      adminFullName: 'Dup Admin',
      acceptedTerms: true,
    };
    await request(app.getHttpServer()).post('/v1/companies').send(body).expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({ ...body, companyName: `Dup Test Co 2 ${suffix}` })
      .expect(409);
    expect(res.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('can update its own profile', async () => {
    const suffix = randomUUID();
    const signup = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `Rename Test Co ${suffix}`,
        adminUsername: `rename-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'Rename Admin',
        acceptedTerms: true,
      })
      .expect(201);
    const token = signup.body.accessToken as string;

    const updated = await request(app.getHttpServer())
      .patch('/v1/companies/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Renamed Co ${suffix}` })
      .expect(200);
    expect(updated.body.name).toBe(`Renamed Co ${suffix}`);
  });

  it("lets any authenticated user read the company's support contact, even with no companies:view", async () => {
    const admin = await createTestTenant([]);
    const adminToken = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username: admin.username, password: TEST_PASSWORD })
      .expect(200);

    // No companies:view/edit granted at all — this is the "driver stuck
    // mid-shift" role, deliberately locked out of company settings.
    const before = await request(app.getHttpServer())
      .get('/v1/companies/me/support')
      .set('Authorization', `Bearer ${adminToken.body.accessToken}`)
      .expect(200);
    expect(before.body).toEqual({ supportPhone: null, supportNotes: null });
  });

  it('lets companies:edit set the support contact, and companies:view see it via /me too', async () => {
    const suffix = randomUUID();
    const signup = await request(app.getHttpServer())
      .post('/v1/companies')
      .send({
        companyName: `Support Test Co ${suffix}`,
        adminUsername: `support-admin-${suffix}`,
        adminPassword: 'a-strong-password',
        adminFullName: 'Support Admin',
        acceptedTerms: true,
      })
      .expect(201);
    const token = signup.body.accessToken as string;

    const updated = await request(app.getHttpServer())
      .patch('/v1/companies/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ supportPhone: '1300 555 000', supportNotes: 'Office hours 6am-6pm; after hours, call the on-call dispatcher.' })
      .expect(200);
    expect(updated.body.supportPhone).toBe('1300 555 000');

    const support = await request(app.getHttpServer())
      .get('/v1/companies/me/support')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(support.body).toEqual({
      supportPhone: '1300 555 000',
      supportNotes: 'Office hours 6am-6pm; after hours, call the on-call dispatcher.',
    });
  });
});
