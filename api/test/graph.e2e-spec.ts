/**
 * 01-Product/Fleet_Graph.md's read side: GET /v1/graph/relationships is the
 * first endpoint over `graph_relationships`, which until now only ever got
 * written to. Also covers the second documented workflow this batch
 * completes — AttachedUnit <-> Asset PAIRED_WITH via hitch/unhitch.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Fleet Graph', () => {
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

  const FULL = [
    PERMISSIONS.ASSETS_CREATE,
    PERMISSIONS.OPERATORS_CREATE,
    PERMISSIONS.DISPATCH_CREATE,
    PERMISSIONS.DISPATCH_ASSIGN,
    PERMISSIONS.ATTACHED_UNITS_CREATE,
    PERMISSIONS.ATTACHED_UNITS_VIEW,
    PERMISSIONS.ATTACHED_UNITS_EDIT,
    PERMISSIONS.FLEET_GRAPH_VIEW,
  ];

  it("shows a current OPERATED relationship on both the asset's and operator's side after a job assignment", async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Graph Truck' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Graph Operator' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Graph Run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);

    const assetGraph = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ASSET', entityId: asset.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(assetGraph.body.items).toEqual([
      expect.objectContaining({
        relationshipType: 'OPERATED',
        direction: 'incoming',
        otherType: 'OPERATOR',
        otherId: operator.body.id,
        otherName: 'Graph Operator',
        isCurrent: true,
        validTo: null,
      }),
    ]);

    const operatorGraph = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'OPERATOR', entityId: operator.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(operatorGraph.body.items).toEqual([
      expect.objectContaining({
        relationshipType: 'OPERATED',
        direction: 'outgoing',
        otherType: 'ASSET',
        otherId: asset.body.id,
        otherName: 'Graph Truck',
        isCurrent: true,
      }),
    ]);
  });

  it('closes the old relationship and opens a new one on reassignment, keeping both visible with the old one marked not-current', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Reassign Truck' }).expect(201);
    const operatorA = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Operator A' }).expect(201);
    const operatorB = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Operator B' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Reassign Run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operatorA.body.id })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operatorB.body.id })
      .expect(201);

    const assetGraph = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ASSET', entityId: asset.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(assetGraph.body.items).toHaveLength(2);
    expect(assetGraph.body.items[0]).toMatchObject({ otherName: 'Operator B', isCurrent: true });
    expect(assetGraph.body.items[1]).toMatchObject({ otherName: 'Operator A', isCurrent: false });
    expect(assetGraph.body.items[1].validTo).not.toBeNull();
  });

  it('rolls up a company-wide graph summary', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Summary Truck' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Summary Operator' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Summary Run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/v1/graph/summary').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.currentCount).toBeGreaterThanOrEqual(1);
    expect(res.body.linkedAssets).toBeGreaterThanOrEqual(1);
    expect(res.body.linkedOperators).toBeGreaterThanOrEqual(1);
    expect(res.body.byType.some((t: { relationshipType: string }) => t.relationshipType === 'OPERATED')).toBe(true);
    expect(res.body.topAssets[0]).toMatchObject({ assetId: asset.body.id, assetName: 'Summary Truck' });
  });

  it('graph summary requires fleet_graph:view', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    await request(app.getHttpServer()).get('/v1/graph/summary').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('hitches and unhitches an attached unit, reflected on both graph endpoints and the attached-unit list', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Tow Truck' }).expect(201);
    const unit = await request(app.getHttpServer()).post('/v1/attached-units').set('Authorization', `Bearer ${token}`).send({ name: 'Trailer 9' }).expect(201);

    const hitched = await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/hitch`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id })
      .expect(201);
    expect(hitched.body.currentAsset).toMatchObject({ id: asset.body.id, name: 'Tow Truck' });

    const list = await request(app.getHttpServer()).get('/v1/attached-units').set('Authorization', `Bearer ${token}`).expect(200);
    const listedUnit = list.body.items.find((u: { id: string }) => u.id === unit.body.id);
    expect(listedUnit.currentAsset).toMatchObject({ id: asset.body.id });

    const unitGraph = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ATTACHED_UNIT', entityId: unit.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(unitGraph.body.items).toEqual([
      expect.objectContaining({ relationshipType: 'PAIRED_WITH', direction: 'outgoing', otherId: asset.body.id, isCurrent: true }),
    ]);

    const unhitched = await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/unhitch`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(unhitched.body.currentAsset).toBeNull();

    const unitGraphAfter = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ATTACHED_UNIT', entityId: unit.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(unitGraphAfter.body.items[0]).toMatchObject({ isCurrent: false });
  });

  it('re-hitching to a different asset closes the previous pairing', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const assetA = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck A' }).expect(201);
    const assetB = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck B' }).expect(201);
    const unit = await request(app.getHttpServer()).post('/v1/attached-units').set('Authorization', `Bearer ${token}`).send({ name: 'Trailer X' }).expect(201);

    await request(app.getHttpServer()).post(`/v1/attached-units/${unit.body.id}/hitch`).set('Authorization', `Bearer ${token}`).send({ assetId: assetA.body.id }).expect(201);
    const rehitched = await request(app.getHttpServer()).post(`/v1/attached-units/${unit.body.id}/hitch`).set('Authorization', `Bearer ${token}`).send({ assetId: assetB.body.id }).expect(201);
    expect(rehitched.body.currentAsset).toMatchObject({ id: assetB.body.id });

    const unitGraph = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ATTACHED_UNIT', entityId: unit.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(unitGraph.body.items).toHaveLength(2);
    expect(unitGraph.body.items[0]).toMatchObject({ otherId: assetB.body.id, isCurrent: true });
    expect(unitGraph.body.items[1]).toMatchObject({ otherId: assetA.body.id, isCurrent: false });
  });

  it('requires fleet_graph:view for the graph endpoint, and attached_units:edit for hitch/unhitch', async () => {
    const noPerm = await createTestTenant([PERMISSIONS.ATTACHED_UNITS_CREATE, PERMISSIONS.ATTACHED_UNITS_VIEW, PERMISSIONS.ASSETS_CREATE]);
    const token = await login(noPerm.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'X' }).expect(201);
    const unit = await request(app.getHttpServer()).post('/v1/attached-units').set('Authorization', `Bearer ${token}`).send({ name: 'Y' }).expect(201);

    const graphRes = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ASSET', entityId: asset.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(graphRes.body.error.requiredPermission).toBe(PERMISSIONS.FLEET_GRAPH_VIEW);

    const hitchRes = await request(app.getHttpServer())
      .post(`/v1/attached-units/${unit.body.id}/hitch`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id })
      .expect(403);
    expect(hitchRes.body.error.requiredPermission).toBe(PERMISSIONS.ATTACHED_UNITS_EDIT);
  });

  it("never surfaces another company's relationships", async () => {
    const tenantA = await createTestTenant(FULL);
    const tokenA = await login(tenantA.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${tokenA}`).send({ name: 'Isolated Truck' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${tokenA}`).send({ fullName: 'Isolated Operator' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${tokenA}`).send({ title: 'Isolated Run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);

    const tenantB = await createTestTenant(FULL);
    const tokenB = await login(tenantB.username);
    // Tenant B queries tenant A's asset id directly — RLS scoping means no rows come back.
    const crossTenant = await request(app.getHttpServer())
      .get('/v1/graph/relationships')
      .query({ entityType: 'ASSET', entityId: asset.body.id })
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(crossTenant.body.items).toEqual([]);
  });
});
