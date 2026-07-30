/**
 * Company document library: upload a file with a title + category, list/filter
 * it, download the bytes back, edit its metadata, and archive it. Bytes reuse
 * the shared Attachment store. Permission-gated (documents:view/create/archive).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const FULL = [PERMISSIONS.DOCUMENTS_VIEW, PERMISSIONS.DOCUMENTS_CREATE, PERMISSIONS.DOCUMENTS_ARCHIVE];

describe('Documents (company file library)', () => {
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

  it('uploads, lists, downloads, edits, and archives a document', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Safety Policy', category: 'Policies', description: 'Company safety policy', filename: 'safety.png', contentType: 'image/png', dataBase64: PNG_B64 })
      .expect(201);
    expect(created.body.title).toBe('Safety Policy');
    expect(created.body.fileAttachment.id).toBeTruthy();
    const id = created.body.id as string;

    const list = await request(app.getHttpServer()).get('/v1/documents').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(id);
    expect(list.body.categories).toContain('Policies');

    // Category filter narrows it.
    const filtered = await request(app.getHttpServer()).get('/v1/documents?category=Policies').set('Authorization', `Bearer ${token}`).expect(200);
    expect(filtered.body.items).toHaveLength(1);

    // Download returns the stored bytes.
    const dl = await request(app.getHttpServer())
      .get(`/v1/documents/${id}/download`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(dl.body as Buffer, Buffer.from(PNG_B64, 'base64'))).toBe(0);

    // Edit metadata.
    const updated = await request(app.getHttpServer())
      .patch(`/v1/documents/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'HR' })
      .expect(200);
    expect(updated.body.category).toBe('HR');

    // Archive removes it from the default listing.
    await request(app.getHttpServer()).post(`/v1/documents/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);
    const after = await request(app.getHttpServer()).get('/v1/documents').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.items.map((d: { id: string }) => d.id)).not.toContain(id);
  });

  it('requires documents:create to upload', async () => {
    const viewer = await createTestTenant([PERMISSIONS.DOCUMENTS_VIEW]);
    const token = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post('/v1/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', filename: 'x.png', contentType: 'image/png', dataBase64: PNG_B64 })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.DOCUMENTS_CREATE);
  });
});
