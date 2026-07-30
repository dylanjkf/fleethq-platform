/**
 * Digital Glovebox v0 milestone (01-Product/Digital_Glovebox.md): the
 * DriverOS-facing view of an asset's compliance document status and
 * emergency contact. Scoped to reusing the already-built ComplianceDocument
 * records — no file upload/document storage in this slice.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions, TEST_PASSWORD } from './utils/fixtures';

describe('Digital Glovebox v0', () => {
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

  const ADMIN_PERMS = [
    PERMISSIONS.ASSETS_CREATE,
    PERMISSIONS.ASSETS_VIEW,
    PERMISSIONS.ASSETS_EDIT,
    PERMISSIONS.COMPLIANCE_CREATE,
  ];

  it('returns the asset, its emergency contact, and its compliance documents with expiry status', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Delivery Van 9', emergencyContact: 'Fleet Office: 1300 555 000' })
      .expect(201);
    expect(asset.body.emergencyContact).toBe('Fleet Office: 1300 555 000');

    const expiredDoc = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: '2020-01-01T00:00:00.000Z' })
      .expect(201);

    const validDoc = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, documentType: 'INSURANCE', expiresAt: '2099-01-01T00:00:00.000Z' })
      .expect(201);

    const glovebox = await request(app.getHttpServer())
      .get(`/v1/assets/${asset.body.id}/glovebox`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(glovebox.body.asset).toMatchObject({
      id: asset.body.id,
      name: 'Delivery Van 9',
      emergencyContact: 'Fleet Office: 1300 555 000',
    });
    expect(glovebox.body.documents).toHaveLength(2);
    const byId = Object.fromEntries(glovebox.body.documents.map((d: { id: string }) => [d.id, d]));
    expect(byId[expiredDoc.body.id].expiryStatus).toBe('expired');
    expect(byId[validDoc.body.id].expiryStatus).toBe('valid');
  });

  it('excludes another asset\'s compliance documents', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const token = await loginAndGetToken(tenant.username);

    const assetA = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Van A' })
      .expect(201);
    const assetB = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Van B' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetB.body.id, documentType: 'ROADWORTHY', expiresAt: '2099-01-01T00:00:00.000Z' })
      .expect(201);

    const glovebox = await request(app.getHttpServer())
      .get(`/v1/assets/${assetA.body.id}/glovebox`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(glovebox.body.documents).toHaveLength(0);
  });

  it('rejects glovebox access without assets:view', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE]);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Van C' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/v1/assets/${asset.body.id}/glovebox`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ASSETS_VIEW);
  });

  it('404s for an asset that does not exist', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const token = await loginAndGetToken(tenant.username);

    await request(app.getHttpServer())
      .get('/v1/assets/00000000-0000-0000-0000-000000000000/glovebox')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('lets an admin update an asset\'s emergency contact', async () => {
    const tenant = await createTestTenant(ADMIN_PERMS);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Van D' })
      .expect(201);
    expect(asset.body.emergencyContact).toBeNull();

    const updated = await request(app.getHttpServer())
      .patch(`/v1/assets/${asset.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ emergencyContact: 'Roadside Assist: 1800 111 222' })
      .expect(200);
    expect(updated.body.emergencyContact).toBe('Roadside Assist: 1800 111 222');
  });
});
