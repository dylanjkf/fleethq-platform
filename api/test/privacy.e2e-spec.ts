/**
 * 14-Security/Privacy_Data_Protection.md's admin-initiated Australian
 * Privacy Act access/erasure path: an admin can export everything FleetOS
 * holds about one Operator, and — once that operator is archived — erase
 * their directly-identifying fields and any scanned compliance documents,
 * without breaking the records (Jobs, Timeline, ...) that reference them.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.OPERATORS_VIEW,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.OPERATORS_ARCHIVE,
  PERMISSIONS.COMPLIANCE_VIEW,
  PERMISSIONS.COMPLIANCE_CREATE,
  PERMISSIONS.ATTACHMENTS_VIEW,
  PERMISSIONS.PRIVACY_EXPORT_DATA,
  PERMISSIONS.PRIVACY_ERASE_DATA,
];

const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Privacy: operator data export + erasure', () => {
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

  async function createOperatorWithLicence(token: string) {
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Dana Driver', email: 'dana@example.com', phone: '0400 000 000' })
      .expect(201);

    const doc = await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operatorId: operator.body.id,
        documentType: 'LICENCE',
        documentNumber: 'LIC-999',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        filePhotoBase64: TINY_PNG_BASE64,
        filePhotoContentType: 'image/png',
        filePhotoFilename: 'licence.png',
      })
      .expect(201);

    const fetchedDoc = await request(app.getHttpServer())
      .get(`/v1/compliance-documents/${doc.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    return { operator: operator.body, doc: fetchedDoc.body };
  }

  it('exports everything FleetOS holds about an operator in one bundle', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { operator, doc } = await createOperatorWithLicence(token);

    const exported = await request(app.getHttpServer())
      .get(`/v1/operators/${operator.id}/data-export`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(exported.body.operator.fullName).toBe('Dana Driver');
    expect(exported.body.operator.email).toBe('dana@example.com');
    expect(exported.body.complianceDocuments).toHaveLength(1);
    expect(exported.body.complianceDocuments[0].id).toBe(doc.id);
    expect(exported.body.complianceDocuments[0].documentNumber).toBe('LIC-999');
    expect(exported.body.complianceDocuments[0].file.filename).toBe('licence.png');
  });

  it('rejects erasing a still-active operator', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { operator } = await createOperatorWithLicence(token);

    const res = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.id}/erase-personal-data`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(res.body.error.code).toBe('OPERATOR_NOT_ARCHIVED');
  });

  it('erases name/contact/licence-number/scan for an archived operator, without breaking the referencing records', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { operator, doc } = await createOperatorWithLicence(token);

    await request(app.getHttpServer()).post(`/v1/operators/${operator.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    const erased = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.id}/erase-personal-data`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(erased.body.erased).toBe(true);

    const fetchedOperator = await request(app.getHttpServer()).get(`/v1/operators/${operator.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(fetchedOperator.body.fullName).toBe('Erased operator');
    expect(fetchedOperator.body.email).toBeNull();
    expect(fetchedOperator.body.phone).toBeNull();
    // The record itself, and its archived state, survive — only PII fields are gone.
    expect(fetchedOperator.body.id).toBe(operator.id);
    expect(fetchedOperator.body.archivedAt).not.toBeNull();

    const fetchedDoc = await request(app.getHttpServer()).get(`/v1/compliance-documents/${doc.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(fetchedDoc.body.documentNumber).toBeNull();
    expect(fetchedDoc.body.documentType).toBe('LICENCE'); // regulatory metadata retained
    expect(fetchedDoc.body.fileAttachment.id).toBe(doc.fileAttachment.id); // FK never dangles

    const download = await request(app.getHttpServer())
      .get(`/v1/attachments/${doc.fileAttachment.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(download.headers['content-length']).toBe('0'); // bytes tombstoned
  });

  it('is idempotent on an already-erased operator', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { operator } = await createOperatorWithLicence(token);
    await request(app.getHttpServer()).post(`/v1/operators/${operator.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    await request(app.getHttpServer()).post(`/v1/operators/${operator.id}/erase-personal-data`).set('Authorization', `Bearer ${token}`).expect(201);
    const second = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.id}/erase-personal-data`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(second.body.erased).toBe(true);
  });

  it('requires privacy:export_data / privacy:erase_data distinctly from operators:view/archive', async () => {
    const noPrivacy = await createTestTenant([
      PERMISSIONS.OPERATORS_VIEW,
      PERMISSIONS.OPERATORS_CREATE,
      PERMISSIONS.OPERATORS_ARCHIVE,
    ]);
    const token = await login(noPrivacy.username);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Sam' }).expect(201);

    const exportRes = await request(app.getHttpServer())
      .get(`/v1/operators/${operator.body.id}/data-export`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(exportRes.body.error.requiredPermission).toBe(PERMISSIONS.PRIVACY_EXPORT_DATA);

    await request(app.getHttpServer()).post(`/v1/operators/${operator.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);
    const eraseRes = await request(app.getHttpServer())
      .post(`/v1/operators/${operator.body.id}/erase-personal-data`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(eraseRes.body.error.requiredPermission).toBe(PERMISSIONS.PRIVACY_ERASE_DATA);
  });
});
