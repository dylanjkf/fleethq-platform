/**
 * Cockpit cross-tenant search (B1). A FleetHQ staff operator searches across ALL
 * tenants from one entry point — by company name, by a user's email/name in any
 * company, by an asset identifier, and by a job/load reference — and every hit
 * shows which company it belongs to so they can jump straight in without already
 * knowing the tenant. `/v1/admin/search` (gated on organisations:view).
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

const ownerPrisma = new PrismaClient();

describe('Cockpit cross-tenant search (B1)', () => {
  let app: INestApplication;
  let adminToken: string;
  const tag = randomUUID().slice(0, 8); // unique marker so results don't collide with other suites

  beforeAll(async () => {
    await ensurePermissions();
    await ensureAssetClasses();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.ORGANISATIONS_VIEW]);
    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = res.body.accessToken as string;
  });
  afterAll(async () => {
    await app.close();
    await ownerPrisma.$disconnect();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  const search = (q: string) =>
    request(app.getHttpServer()).get('/v1/admin/search').query({ q }).set('Authorization', `Bearer ${adminToken}`);
  const customerLogin = async (username: string) =>
    (await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200)).body
      .accessToken as string;

  it('finds a company, a user (with their company), an asset and a job — each company-scoped — across tenants', async () => {
    const companyName = `Zephyr Freight ${tag}`;
    const email = `driver.${tag}@example.test`;
    const assetName = `Reg${tag}Truck`;
    const jobTitle = `Load-${tag}-9000`;

    // Seed one tenant and give it distinctive, searchable data.
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.DISPATCH_CREATE]);
    await ownerPrisma.company.update({ where: { id: tenant.companyId }, data: { name: companyName } });
    await ownerPrisma.user.update({ where: { id: tenant.userId }, data: { email, fullName: `Driver ${tag}` } });
    const token = await customerLogin(tenant.username);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: assetName }).expect(201);
    await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: jobTitle }).expect(201);

    // By company name.
    const byCompany = (await search(companyName).expect(200)).body;
    expect(byCompany.companies).toEqual(expect.arrayContaining([expect.objectContaining({ id: tenant.companyId, name: companyName })]));

    // By the user's email — the result carries the company so a support operator
    // knows which tenant to open.
    const byEmail = (await search(email).expect(200)).body;
    const userHit = byEmail.users.find((u: { email: string }) => u.email === email);
    expect(userHit).toBeDefined();
    expect(userHit.companies).toEqual(expect.arrayContaining([expect.objectContaining({ id: tenant.companyId, name: companyName })]));

    // By an asset identifier — company-scoped.
    const byAsset = (await search(assetName).expect(200)).body;
    const assetHit = byAsset.assets.find((a: { name: string }) => a.name === assetName);
    expect(assetHit).toBeDefined();
    expect(assetHit.company).toEqual(expect.objectContaining({ id: tenant.companyId, name: companyName }));

    // By a job/load reference — company-scoped.
    const byJob = (await search(jobTitle).expect(200)).body;
    const jobHit = byJob.jobs.find((j: { title: string }) => j.title === jobTitle);
    expect(jobHit).toBeDefined();
    expect(jobHit.company).toEqual(expect.objectContaining({ id: tenant.companyId, name: companyName }));
  });

  it('requires organisations:view, and rejects an unauthenticated request', async () => {
    await search('anything').expect(200); // adminToken holds organisations:view
    await request(app.getHttpServer()).get('/v1/admin/search').query({ q: 'anything' }).expect(401);

    const weakAdmin = await createTestAdmin([ADMIN_PERMISSIONS.SYSTEM_VIEW]); // no organisations:view
    const weakRes = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: weakAdmin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    await request(app.getHttpServer())
      .get('/v1/admin/search')
      .query({ q: 'anything' })
      .set('Authorization', `Bearer ${weakRes.body.accessToken}`)
      .expect(403);
  });
});
