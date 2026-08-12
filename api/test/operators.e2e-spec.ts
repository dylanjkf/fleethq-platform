/**
 * Operators CRUD + permission gating (audit H7). Operators are a core entity
 * (drivers/personnel, carrying PII) that previously had e2e coverage only for
 * decommissioning and glovebox docs — not the create/list/read/update/archive
 * surface or its per-action permission gates. This closes that gap end-to-end
 * against real Postgres.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.OPERATORS_VIEW,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.OPERATORS_EDIT,
  PERMISSIONS.OPERATORS_ARCHIVE,
];

describe('Operators', () => {
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
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('creates, lists, reads, edits, and archives an operator', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/operators')
      .set(auth(token))
      .send({ fullName: 'Sam Driver', email: 'sam@carrier.test', phone: '0400 000 000' })
      .expect(201);
    expect(created.body.fullName).toBe('Sam Driver');
    const id = created.body.id as string;

    const list = await request(app.getHttpServer()).get('/v1/operators').set(auth(token)).expect(200);
    expect(list.body.items.map((o: { id: string }) => o.id)).toContain(id);

    const read = await request(app.getHttpServer()).get(`/v1/operators/${id}`).set(auth(token)).expect(200);
    expect(read.body.email).toBe('sam@carrier.test');

    const edited = await request(app.getHttpServer())
      .patch(`/v1/operators/${id}`)
      .set(auth(token))
      .send({ phone: '0411 111 111' })
      .expect(200);
    expect(edited.body.phone).toBe('0411 111 111');

    await request(app.getHttpServer()).post(`/v1/operators/${id}/archive`).set(auth(token)).expect(201);
    const afterArchive = await request(app.getHttpServer()).get('/v1/operators').set(auth(token)).expect(200);
    expect(afterArchive.body.items.map((o: { id: string }) => o.id)).not.toContain(id);
  });

  it('validates the payload (fullName is required)', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).post('/v1/operators').set(auth(token)).send({ email: 'noname@x.test' }).expect(400);
  });

  it('requires operators:create to create and operators:view to list', async () => {
    // A tenant with edit/archive but NOT create or view.
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_EDIT, PERMISSIONS.OPERATORS_ARCHIVE]);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).post('/v1/operators').set(auth(token)).send({ fullName: 'Nope' }).expect(403);
    await request(app.getHttpServer()).get('/v1/operators').set(auth(token)).expect(403);
  });

  it('requires operators:edit to update and operators:archive to archive', async () => {
    // Can create + read its own operators, but holds neither edit nor archive.
    const tenant = await createTestTenant([PERMISSIONS.OPERATORS_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const id = (
      await request(app.getHttpServer()).post('/v1/operators').set(auth(token)).send({ fullName: 'Pat Driver' }).expect(201)
    ).body.id as string;

    // Reads are allowed; both mutations are denied by their own permission gate.
    await request(app.getHttpServer()).get(`/v1/operators/${id}`).set(auth(token)).expect(200);
    await request(app.getHttpServer()).patch(`/v1/operators/${id}`).set(auth(token)).send({ phone: '0000' }).expect(403);
    await request(app.getHttpServer()).post(`/v1/operators/${id}/archive`).set(auth(token)).expect(403);
  });
});
