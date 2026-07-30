/**
 * 01-Product/Universal_Search.md's non-AI fallback slice: literal
 * substring search across the entity types a user has permission to view.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Universal Search', () => {
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

  it('finds an asset and an operator by partial, case-insensitive name', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.OPERATORS_CREATE, PERMISSIONS.OPERATORS_VIEW]);
    const token = await login(tenant.username);

    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Volvo FH16' }).expect(201);
    await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Dana Driver' }).expect(201);

    const res = await request(app.getHttpServer()).get('/v1/search').query({ q: 'volvo' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual([
      expect.objectContaining({ type: 'asset', title: 'Volvo FH16', linkPath: '/fleet' }),
    ]);

    const res2 = await request(app.getHttpServer()).get('/v1/search').query({ q: 'dana' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res2.body).toEqual([
      expect.objectContaining({ type: 'operator', title: 'Dana Driver', linkPath: '/operators' }),
    ]);
  });

  it('never surfaces a result for a type the caller lacks :view for', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Volvo FH16' }).expect(201);

    // Same tenant, a second user with only operators:view — no assets:view.
    const noAssetView = await createTestTenant([PERMISSIONS.OPERATORS_VIEW]);
    const noAssetToken = await login(noAssetView.username);
    const res = await request(app.getHttpServer()).get('/v1/search').query({ q: 'volvo' }).set('Authorization', `Bearer ${noAssetToken}`).expect(200);
    expect(res.body).toEqual([]);
  });

  it("never surfaces another company's matching records", async () => {
    const tenantA = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const tokenA = await login(tenantA.username);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Shared Name Truck' }).expect(201);

    const tenantB = await createTestTenant([PERMISSIONS.ASSETS_VIEW]);
    const tokenB = await login(tenantB.username);
    const res = await request(app.getHttpServer()).get('/v1/search').query({ q: 'shared name' }).set('Authorization', `Bearer ${tokenB}`).expect(200);
    expect(res.body).toEqual([]);
  });

  it('ranks an exact match above a mere substring match', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck 17 Extended' }).expect(201);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck 17' }).expect(201);

    const res = await request(app.getHttpServer()).get('/v1/search').query({ q: 'Truck 17' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.map((r: { title: string }) => r.title)).toEqual(['Truck 17', 'Truck 17 Extended']);
  });

  it('returns nothing for a 1-character query, and an empty array for no matches', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_VIEW]);
    const token = await login(tenant.username);

    const short = await request(app.getHttpServer()).get('/v1/search').query({ q: 'a' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(short.body).toEqual([]);

    const none = await request(app.getHttpServer()).get('/v1/search').query({ q: 'no-such-thing-at-all' }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(none.body).toEqual([]);
  });

  it('requires no special permission for the search endpoint itself', async () => {
    const tenant = await createTestTenant([]);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).get('/v1/search').query({ q: 'anything' }).set('Authorization', `Bearer ${token}`).expect(200);
  });
});
