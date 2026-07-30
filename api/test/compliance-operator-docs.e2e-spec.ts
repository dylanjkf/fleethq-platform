/**
 * Compliance operator docs (licence, medical certificate) + Glovebox file
 * uploads: a compliance document can now belong to an Operator instead of an
 * Asset (never both), optionally carrying a scan/photo Attachment, and the
 * operator's own Digital Glovebox (GET /v1/operators/:id/glovebox) surfaces
 * them the same way the asset glovebox already does.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.COMPLIANCE_VIEW,
  PERMISSIONS.COMPLIANCE_CREATE,
  PERMISSIONS.COMPLIANCE_EDIT,
  PERMISSIONS.OPERATORS_VIEW,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.ATTACHMENTS_VIEW,
];

// A 1x1 transparent PNG, small enough to keep the test fast.
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Compliance operator docs + Glovebox file uploads', () => {
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

  it('logs a licence document against an operator, with a file scan attached', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Dana Driver' }).expect(201);

    const created = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operatorId: operator.body.id,
        documentType: 'LICENCE',
        documentNumber: 'LIC-123',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        filePhotoBase64: TINY_PNG_BASE64,
        filePhotoContentType: 'image/png',
        filePhotoFilename: 'licence.png',
      })
      .expect(201);
    expect(created.body.operatorId).toBe(operator.body.id);
    expect(created.body.assetId).toBeNull();

    const fetched = await request(app.getHttpServer()).get(`/v1/compliance-documents/${created.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(fetched.body.operator.fullName).toBe('Dana Driver');
    expect(fetched.body.fileAttachment.filename).toBe('licence.png');

    const download = await request(app.getHttpServer()).get(`/v1/attachments/${fetched.body.fileAttachment.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(download.headers['content-type']).toContain('image/png');
  });

  it('rejects a document with both or neither of asset/operator', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Dana Driver' }).expect(201);

    const neither = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ documentType: 'LICENCE', expiresAt: new Date().toISOString() })
      .expect(400);
    expect(neither.body.error.code).toBe('COMPLIANCE_DOCUMENT_TARGET_REQUIRED');

    const both = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id, documentType: 'LICENCE', expiresAt: new Date().toISOString() })
      .expect(400);
    expect(both.body.error.code).toBe('COMPLIANCE_DOCUMENT_TARGET_REQUIRED');
  });

  it('surfaces an operator’s documents through their Glovebox', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Dana Driver' }).expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ operatorId: operator.body.id, documentType: 'MEDICAL_CERTIFICATE', expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() })
      .expect(201);

    const glovebox = await request(app.getHttpServer()).get(`/v1/operators/${operator.body.id}/glovebox`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(glovebox.body.operator.fullName).toBe('Dana Driver');
    expect(glovebox.body.documents).toHaveLength(1);
    expect(glovebox.body.documents[0].documentType).toBe('MEDICAL_CERTIFICATE');
  });
});
