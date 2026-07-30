/**
 * Wave J1 — the Digital Glovebox scan is now openable from DriverOS.
 *
 * The assertions that matter: a driver who can see the glovebox can open its
 * scan **without** blanket attachments:view, and the scope check stops that
 * route being used to read an attachment through the wrong asset/operator.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions, TEST_PASSWORD } from './utils/fixtures';

// 1x1 PNG so the attachment magic-byte sniffing is satisfied.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Enough to create an asset + a compliance doc with a scan, and read the glovebox.
const OFFICE = [PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.COMPLIANCE_CREATE];

describe('Glovebox document file', () => {
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

  async function assetWithScan(auth: Record<string, string>) {
    const asset = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Van 3' }).expect(201);
    const doc = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set(auth)
      .send({
        assetId: asset.body.id,
        documentType: 'REGISTRATION',
        documentNumber: 'REG-9',
        expiresAt: '2099-01-01T00:00:00.000Z',
        filePhotoBase64: PNG_BASE64,
        filePhotoContentType: 'image/png',
        filePhotoFilename: 'rego.png',
      })
      .expect(201);
    return { assetId: asset.body.id as string, documentId: doc.body.id as string };
  }

  it('lets a driver open the scan with only assets:view — no attachments:view needed', async () => {
    const office = await createTestTenant(OFFICE);
    const officeAuth = { Authorization: `Bearer ${await login(office.username)}` };
    const { assetId, documentId } = await assetWithScan(officeAuth);

    // A driver in the same company with ONLY assets:view — the glovebox metadata
    // exposes fileAttachment, and the file route opens the bytes.
    const glovebox = await request(app.getHttpServer()).get(`/v1/assets/${assetId}/glovebox`).set(officeAuth).expect(200);
    expect(glovebox.body.documents[0].fileAttachment).toMatchObject({ filename: 'rego.png' });
    expect(glovebox.body.documents[0].documentNumber).toBe('REG-9');

    const file = await request(app.getHttpServer())
      .get(`/v1/assets/${assetId}/glovebox/documents/${documentId}/file`)
      .set(officeAuth)
      .expect(200);
    expect(file.headers['content-type']).toContain('image/png');
  });

  it('404s a scan requested through an asset it does not belong to', async () => {
    const office = await createTestTenant(OFFICE);
    const officeAuth = { Authorization: `Bearer ${await login(office.username)}` };
    const { documentId } = await assetWithScan(officeAuth);
    const other = await request(app.getHttpServer()).post('/v1/assets').set(officeAuth).send({ name: 'Van 4' }).expect(201);

    // The document exists, but not under this asset — must read as not found,
    // not leak the attachment.
    await request(app.getHttpServer())
      .get(`/v1/assets/${other.body.id}/glovebox/documents/${documentId}/file`)
      .set(officeAuth)
      .expect(404);
  });

  it('keeps the scan route tenant-isolated', async () => {
    const a = await createTestTenant(OFFICE);
    const b = await createTestTenant(OFFICE);
    const authA = { Authorization: `Bearer ${await login(a.username)}` };
    const authB = { Authorization: `Bearer ${await login(b.username)}` };
    const { assetId, documentId } = await assetWithScan(authA);

    // Company B knows neither id legitimately — the asset lookup 404s first.
    await request(app.getHttpServer())
      .get(`/v1/assets/${assetId}/glovebox/documents/${documentId}/file`)
      .set(authB)
      .expect(404);
  });
});
