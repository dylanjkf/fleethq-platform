/**
 * Compliance-expiry alert sweep: the leader-elected scheduler's per-company job
 * that raises an in-app notification the first time a document crosses into
 * "expiring soon" or "expired". Proves the right alerts fire, that they fan out
 * to compliance:view holders, and that the sweep is idempotent (a second run
 * raises nothing new).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { ComplianceService } from '../src/compliance/compliance.service';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Compliance expiry sweep', () => {
  let app: INestApplication;
  let compliance: ComplianceService;

  beforeAll(async () => {
    app = await buildTestApp();
    compliance = app.get(ComplianceService);
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<Record<string, string>> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  function daysFromNow(days: number): string {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  it('alerts on newly expiring/expired documents once, and is idempotent + valid-safe', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.COMPLIANCE_VIEW,
      PERMISSIONS.COMPLIANCE_CREATE,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const auth = await login(tenant.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Sweep Truck' }).expect(201);
    const assetId = asset.body.id as string;

    // Expiring in 10 days, already expired 5 days ago, and valid for a year.
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set(auth)
      .send({ assetId, documentType: 'REGISTRATION', expiresAt: daysFromNow(10) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set(auth)
      .send({ assetId, documentType: 'INSURANCE', expiresAt: daysFromNow(-5) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set(auth)
      .send({ assetId, documentType: 'ROADWORTHY', expiresAt: daysFromNow(400) })
      .expect(201);

    const first = await compliance.sweepExpiries(tenant.companyId);
    expect(first).toEqual({ expiring: 1, expired: 1 });

    // The compliance:view holder got exactly the two alerts (valid doc silent).
    const listed = await request(app.getHttpServer()).get('/v1/notifications').set(auth).expect(200);
    const types = (listed.body.items as { type: string }[]).map((n) => n.type).sort();
    expect(types).toEqual(['compliance_expired', 'compliance_expiring']);

    // Idempotent: a second sweep raises nothing, and no new notifications land.
    const second = await compliance.sweepExpiries(tenant.companyId);
    expect(second).toEqual({ expiring: 0, expired: 0 });
    const listedAgain = await request(app.getHttpServer()).get('/v1/notifications').set(auth).expect(200);
    expect((listedAgain.body.items as unknown[]).length).toBe(2);
  });

  it('is tenant-scoped — a sweep never alerts another company', async () => {
    const a = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.COMPLIANCE_CREATE, PERMISSIONS.ASSETS_CREATE]);
    const b = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW]);
    const authA = await login(a.username);
    const authB = await login(b.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set(authA).send({ name: 'A Truck' }).expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set(authA)
      .send({ assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(-1) })
      .expect(201);

    await compliance.sweepExpiries(a.companyId);

    // Company B holds compliance:view but had nothing swept — no alerts.
    const listedB = await request(app.getHttpServer()).get('/v1/notifications').set(authB).expect(200);
    expect((listedB.body.items as unknown[]).length).toBe(0);
  });
});
