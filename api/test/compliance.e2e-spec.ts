/**
 * Compliance milestone: per-asset document expiry tracking (registration/
 * insurance/roadworthy) with a derived (never stored) expiry status, plus
 * the archive-as-correction lifecycle shared with Asset/Operator/AttachedUnit.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

describe('Compliance (Compliance milestone)', () => {
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

  async function loginAndGetToken(username: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  function daysFromNow(days: number): string {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  it('logs a compliance document, computes its expiry status, edits it, then archives it', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.COMPLIANCE_VIEW,
      PERMISSIONS.COMPLIANCE_CREATE,
      PERMISSIONS.COMPLIANCE_EDIT,
      PERMISSIONS.COMPLIANCE_ARCHIVE,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Compliance Test Truck' })
      .expect(201);

    const document = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        assetId: asset.body.id,
        documentType: 'REGISTRATION',
        documentNumber: 'REGO-1234',
        expiresAt: daysFromNow(10),
      })
      .expect(201);
    expect(document.body.documentType).toBe('REGISTRATION');
    expect(document.body.expiryStatus).toBe('expiring_soon');

    const updated = await request(app.getHttpServer())
      .patch(`/v1/compliance-documents/${document.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expiresAt: daysFromNow(90) })
      .expect(200);
    expect(updated.body.expiryStatus).toBe('valid');

    const expired = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        assetId: asset.body.id,
        documentType: 'INSURANCE',
        expiresAt: daysFromNow(-5),
      })
      .expect(201);
    expect(expired.body.expiryStatus).toBe('expired');

    const archived = await request(app.getHttpServer())
      .post(`/v1/compliance-documents/${document.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(archived.body.archivedAt).not.toBeNull();

    const listDefault = await request(app.getHttpServer())
      .get('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listDefault.body.items.map((d: { id: string }) => d.id)).not.toContain(document.body.id);

    const listIncludingArchived = await request(app.getHttpServer())
      .get('/v1/compliance-documents?includeArchived=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listIncludingArchived.body.items.map((d: { id: string }) => d.id)).toContain(document.body.id);
  });

  it('filters by assetId', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.COMPLIANCE_VIEW,
      PERMISSIONS.COMPLIANCE_CREATE,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);

    const assetA = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Asset A' })
      .expect(201);
    const assetB = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Asset B' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetA.body.id, documentType: 'ROADWORTHY', expiresAt: daysFromNow(60) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetB.body.id, documentType: 'ROADWORTHY', expiresAt: daysFromNow(60) })
      .expect(201);

    const filtered = await request(app.getHttpServer())
      .get(`/v1/compliance-documents?assetId=${assetA.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].assetId).toBe(assetA.body.id);
  });

  it('is tenant-isolated and rejects a document against another company\'s asset', async () => {
    const allPerms = [PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.COMPLIANCE_CREATE, PERMISSIONS.ASSETS_CREATE];
    const tenantA = await createTestTenant(allPerms);
    const tenantB = await createTestTenant(allPerms);
    const tokenA = await loginAndGetToken(tenantA.username);
    const tokenB = await loginAndGetToken(tenantB.username);

    const assetB = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Company B Truck' })
      .expect(201);

    const crossTenant = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ assetId: assetB.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(60) })
      .expect(404);
    expect(crossTenant.body.error.code).toBe('ASSET_NOT_FOUND');

    const assetA = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Company A Truck' })
      .expect(201);
    const documentA = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ assetId: assetA.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(60) })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/v1/compliance-documents/${documentA.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('summarises document currency (valid / expiring soon / expired) for the dashboard', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.COMPLIANCE_CREATE, PERMISSIONS.ASSETS_CREATE]);
    const token = await loginAndGetToken(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const asset = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Summary Truck' }).expect(201);
    const make = (days: number) =>
      request(app.getHttpServer()).post('/v1/compliance-documents').set(auth).send({ assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(days) }).expect(201);

    await make(-5); // expired
    await make(10); // expiring soon (within 30d)
    await make(200); // valid

    const summary = await request(app.getHttpServer()).get('/v1/compliance-documents/summary').set(auth).expect(200);
    expect(summary.body).toEqual({ total: 3, valid: 1, expiringSoon: 1, expired: 1 });

    // Gated on compliance:view.
    const noPerm = await createTestTenant([PERMISSIONS.ASSETS_CREATE]);
    const noPermToken = await loginAndGetToken(noPerm.username);
    await request(app.getHttpServer()).get('/v1/compliance-documents/summary').set('Authorization', `Bearer ${noPermToken}`).expect(403);
  });

  it('reports the six live compliance-position rates for the dashboard', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.COMPLIANCE_VIEW,
      PERMISSIONS.COMPLIANCE_CREATE,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.OPERATORS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    // Two assets; one carries a current registration, insurance and roadworthy.
    const assetA = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Position Truck A' }).expect(201);
    await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Position Truck B' }).expect(201);
    for (const documentType of ['REGISTRATION', 'INSURANCE', 'ROADWORTHY']) {
      await request(app.getHttpServer())
        .post('/v1/compliance-documents')
        .set(auth)
        .send({ assetId: assetA.body.id, documentType, expiresAt: daysFromNow(120) })
        .expect(201);
    }

    // One operator with a current licence.
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set(auth)
      .send({ fullName: 'Pat Licence' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set(auth)
      .send({ operatorId: operator.body.id, documentType: 'LICENCE', expiresAt: daysFromNow(200) })
      .expect(201);

    const position = await request(app.getHttpServer()).get('/v1/compliance-documents/position').set(auth).expect(200);
    // 1 of 2 assets current on each vehicle doc; 1 of 1 operators licensed.
    expect(position.body.roadworthy).toEqual({ current: 1, total: 2 });
    expect(position.body.insurance).toEqual({ current: 1, total: 2 });
    expect(position.body.registration).toEqual({ current: 1, total: 2 });
    expect(position.body.driverLicences).toEqual({ current: 1, total: 1 });
    // No stops recorded, no pre-starts submitted for this fresh tenant.
    expect(position.body.deliveries).toEqual({ current: 0, total: 0 });
    expect(position.body.prestart).toEqual({ current: 0, total: 2 });

    // Gated on compliance:view.
    const noPerm = await createTestTenant([PERMISSIONS.ASSETS_CREATE]);
    const noPermToken = await loginAndGetToken(noPerm.username);
    await request(app.getHttpServer()).get('/v1/compliance-documents/position').set('Authorization', `Bearer ${noPermToken}`).expect(403);
  });

  it('rejects compliance:create without the permission', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.ASSETS_CREATE]);
    const token = await loginAndGetToken(viewOnly.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Truck' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(60) })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.COMPLIANCE_CREATE);
  });
});
