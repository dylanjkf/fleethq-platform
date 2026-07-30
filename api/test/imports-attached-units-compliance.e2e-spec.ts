/**
 * Bulk import extended to AttachedUnits and Compliance documents
 * (01-Product/Onboarding_Import.md) — same dry-run/commit shape as the other
 * imports, reusing AttachedUnitsService/ComplianceService.create() per row.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Imports: AttachedUnits + Compliance documents', () => {
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

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('dry-runs then commits an AttachedUnits import, skipping only the invalid row', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ATTACHED_UNITS_CREATE, PERMISSIONS.ATTACHED_UNITS_VIEW]);
    const token = await login(tenant.username);

    const dryRun = await request(app.getHttpServer())
      .post('/v1/imports/attached-units')
      .set('Authorization', `Bearer ${token}`)
      .send({ dryRun: true, rows: [{ name: 'Trailer 1' }, { externalReference: 'no name here' }] })
      .expect(201);
    expect(dryRun.body).toMatchObject({ total: 2, validCount: 1, invalidCount: 1, createdCount: 0 });

    const commit = await request(app.getHttpServer())
      .post('/v1/imports/attached-units')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'Trailer 1' }, { externalReference: 'no name here' }] })
      .expect(201);
    expect(commit.body.createdCount).toBe(1);

    const list = await request(app.getHttpServer()).get('/v1/attached-units').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.map((u: { name: string }) => u.name)).toContain('Trailer 1');
  });

  it('dry-runs then commits a Compliance documents import against assets, skipping an invalid row', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.COMPLIANCE_CREATE,
      PERMISSIONS.COMPLIANCE_VIEW,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);

    const rows = [
      { assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: '2027-01-01T00:00:00.000Z' },
      { documentType: 'REGISTRATION', expiresAt: '2027-01-01T00:00:00.000Z' }, // no assetId/operatorId — invalid
    ];

    const dryRun = await request(app.getHttpServer())
      .post('/v1/imports/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ dryRun: true, rows })
      .expect(201);
    // Both rows pass DTO-level validation (assetId/operatorId are each optional)
    // — the "exactly one" rule is enforced at create time, not by the DTO.
    expect(dryRun.body.validCount).toBe(2);
    expect(dryRun.body.createdCount).toBe(0);

    const commit = await request(app.getHttpServer())
      .post('/v1/imports/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows })
      .expect(201);
    expect(commit.body.createdCount).toBe(1);
    expect(commit.body.rows[1].valid).toBe(false);

    const list = await request(app.getHttpServer()).get('/v1/compliance-documents').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.total).toBe(1);
  });

  it('requires attached_units:create / compliance:create respectively', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.ATTACHED_UNITS_VIEW, PERMISSIONS.COMPLIANCE_VIEW]);
    const token = await login(viewOnly.username);

    const unitsRes = await request(app.getHttpServer())
      .post('/v1/imports/attached-units')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ name: 'X' }] })
      .expect(403);
    expect(unitsRes.body.error.requiredPermission).toBe(PERMISSIONS.ATTACHED_UNITS_CREATE);

    const complianceRes = await request(app.getHttpServer())
      .post('/v1/imports/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ documentType: 'REGISTRATION', expiresAt: '2027-01-01T00:00:00.000Z' }] })
      .expect(403);
    expect(complianceRes.body.error.requiredPermission).toBe(PERMISSIONS.COMPLIANCE_CREATE);
  });
});
