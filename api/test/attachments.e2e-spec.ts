/**
 * Attachments (photo/file storage): base64-over-JSON upload, byte-accurate
 * round-trip download, type/size validation, tenant isolation, permissions.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('Attachments (photo/file storage)', () => {
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
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('uploads a photo and downloads the exact bytes back', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ATTACHMENTS_UPLOAD, PERMISSIONS.ATTACHMENTS_VIEW]);
    const token = await login(tenant.username);

    const up = await request(app.getHttpServer())
      .post('/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'pod.png', contentType: 'image/png', dataBase64: `data:image/png;base64,${PNG_B64}` })
      .expect(201);
    expect(up.body.id).toBeDefined();
    expect(up.body.byteSize).toBe(Buffer.from(PNG_B64, 'base64').length);
    expect(up.body.data).toBeUndefined(); // never return the bytes on upload

    const down = await request(app.getHttpServer())
      .get(`/v1/attachments/${up.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(down.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(down.body as Buffer, Buffer.from(PNG_B64, 'base64'))).toBe(0);
  });

  it('rejects an unsupported content type', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ATTACHMENTS_UPLOAD]);
    const token = await login(tenant.username);
    const res = await request(app.getHttpServer())
      .post('/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'x.exe', contentType: 'application/octet-stream', dataBase64: 'AAAA' })
      .expect(400);
    // class-validator rejects the enum before the service runs.
    expect(res.body.error).toBeDefined();
  });

  it('rejects a file whose bytes do not match its declared type (magic-byte sniff)', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ATTACHMENTS_UPLOAD]);
    const token = await login(tenant.username);
    // Declared image/png, but the bytes are plain text ("hello") — a mislabelled
    // or disguised file. The magic-byte check must reject it.
    const res = await request(app.getHttpServer())
      .post('/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'fake.png', contentType: 'image/png', dataBase64: Buffer.from('hello world, not a png').toString('base64') })
      .expect(400);
    expect(res.body.error.code).toBe('ATTACHMENT_CONTENT_MISMATCH');
  });

  it('is tenant-isolated on download', async () => {
    const a = await createTestTenant([PERMISSIONS.ATTACHMENTS_UPLOAD, PERMISSIONS.ATTACHMENTS_VIEW]);
    const b = await createTestTenant([PERMISSIONS.ATTACHMENTS_VIEW]);
    const tokenA = await login(a.username);
    const tokenB = await login(b.username);
    const up = await request(app.getHttpServer())
      .post('/v1/attachments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ filename: 'a.png', contentType: 'image/png', dataBase64: PNG_B64 })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v1/attachments/${up.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('requires attachments:upload', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.ATTACHMENTS_VIEW]);
    const token = await login(viewOnly.username);
    const res = await request(app.getHttpServer())
      .post('/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'a.png', contentType: 'image/png', dataBase64: PNG_B64 })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ATTACHMENTS_UPLOAD);
  });
});
