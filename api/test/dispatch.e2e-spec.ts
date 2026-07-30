/**
 * Dispatch milestone: AttachedUnit CRUD (mirrors Assets/Operators) and the Job
 * lifecycle (create/assign/complete/cancel), including the one behavior this
 * milestone adds that no prior resource has: writing a real GraphRelationship
 * row (05-Dispatch/Dispatch_Overview.md, 01-Product/Fleet_Graph.md).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const ownerPrisma = new PrismaClient();

describe('Dispatch (AttachedUnits + Jobs)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });

  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function loginAndGetToken(username: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ username, password: TEST_PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  it('AttachedUnit CRUD works and is tenant-isolated', async () => {
    const allPerms = [
      PERMISSIONS.ATTACHED_UNITS_VIEW,
      PERMISSIONS.ATTACHED_UNITS_CREATE,
      PERMISSIONS.ATTACHED_UNITS_EDIT,
      PERMISSIONS.ATTACHED_UNITS_ARCHIVE,
    ];
    const tenantA = await createTestTenant(allPerms);
    const tenantB = await createTestTenant(allPerms);
    const tokenA = await loginAndGetToken(tenantA.username);
    const tokenB = await loginAndGetToken(tenantB.username);

    const createB = await request(app.getHttpServer())
      .post('/v1/attached-units')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Company B Trailer' })
      .expect(201);

    const createA = await request(app.getHttpServer())
      .post('/v1/attached-units')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Company A Trailer' })
      .expect(201);

    const listA = await request(app.getHttpServer())
      .get('/v1/attached-units')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    const idsVisibleToA = listA.body.items.map((u: { id: string }) => u.id);
    expect(idsVisibleToA).toContain(createA.body.id);
    expect(idsVisibleToA).not.toContain(createB.body.id);

    await request(app.getHttpServer())
      .get(`/v1/attached-units/${createB.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    const updated = await request(app.getHttpServer())
      .patch(`/v1/attached-units/${createA.body.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Renamed Trailer' })
      .expect(200);
    expect(updated.body.name).toBe('Renamed Trailer');

    await request(app.getHttpServer())
      .post(`/v1/attached-units/${createA.body.id}/archive`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(201);
  });

  it('rejects attached-units:create without the permission', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.ATTACHED_UNITS_VIEW]);
    const token = await loginAndGetToken(viewOnly.username);

    const res = await request(app.getHttpServer())
      .post('/v1/attached-units')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Should not be created' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ATTACHED_UNITS_CREATE);
  });

  it('creates a job, assigns it to an asset and operator, and opens a timed OPERATED GraphRelationship', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.DISPATCH_VIEW,
      PERMISSIONS.DISPATCH_CREATE,
      PERMISSIONS.DISPATCH_ASSIGN,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.OPERATORS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dispatch Test Truck' })
      .expect(201);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Dispatch Test Operator' })
      .expect(201);

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Deliver parcels' })
      .expect(201);
    expect(job.body.status).toBe('UNASSIGNED');

    const assigned = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);
    expect(assigned.body.status).toBe('ASSIGNED');
    expect(assigned.body.assetId).toBe(asset.body.id);
    expect(assigned.body.operatorId).toBe(operator.body.id);

    const relationship = await ownerPrisma.graphRelationship.findFirst({
      where: {
        companyId: tenant.companyId,
        sourceType: 'OPERATOR',
        sourceId: operator.body.id,
        targetType: 'ASSET',
        targetId: asset.body.id,
        relationshipType: 'OPERATED',
      },
    });
    expect(relationship).not.toBeNull();
    expect(relationship?.validTo).toBeNull();
  });

  it('closes the OPERATED relationship on complete, and rejects further changes to a terminal job', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.DISPATCH_VIEW,
      PERMISSIONS.DISPATCH_CREATE,
      PERMISSIONS.DISPATCH_ASSIGN,
      PERMISSIONS.DISPATCH_EDIT,
      PERMISSIONS.DISPATCH_CANCEL,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.OPERATORS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Truck' })
      .expect(201);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Operator' })
      .expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Job to complete', assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);

    const completed = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(completed.body.status).toBe('COMPLETED');

    const relationship = await ownerPrisma.graphRelationship.findFirst({
      where: {
        companyId: tenant.companyId,
        sourceType: 'OPERATOR',
        sourceId: operator.body.id,
        targetType: 'ASSET',
        targetId: asset.body.id,
        relationshipType: 'OPERATED',
      },
    });
    expect(relationship?.validTo).not.toBeNull();

    const editAfterComplete = await request(app.getHttpServer())
      .patch(`/v1/jobs/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should not apply' })
      .expect(409);
    expect(editAfterComplete.body.error.code).toBe('JOB_TERMINAL');

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
  });

  it('rejects dispatch:assign without the permission, and job creation referencing another company\'s asset', async () => {
    const tenantA = await createTestTenant([PERMISSIONS.DISPATCH_CREATE, PERMISSIONS.ASSETS_CREATE]);
    const tenantB = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW]);
    const tokenA = await loginAndGetToken(tenantA.username);
    const tokenB = await loginAndGetToken(tenantB.username);

    const assetB = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Company B Truck' })
      .expect(201);

    // Company A can't create a job assigned to Company B's asset.
    const crossTenant = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Cross-tenant attempt', assetId: assetB.body.id })
      .expect(404);
    expect(crossTenant.body.error.code).toBe('ASSET_NOT_FOUND');

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ title: 'Needs assignment' })
      .expect(201);

    // dispatch:assign was never granted to tenant A's role.
    const denied = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ assetId: null })
      .expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_ASSIGN);
  });

  it('rejects a stale reassignment with JOB_MODIFIED (optimistic concurrency)', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.DISPATCH_VIEW,
      PERMISSIONS.DISPATCH_CREATE,
      PERMISSIONS.DISPATCH_ASSIGN,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);

    const assetA = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck A' }).expect(201);
    const assetB = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Truck B' }).expect(201);

    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Contended run' }).expect(201);
    const staleToken = job.body.updatedAt as string;

    // Dispatcher 1 assigns Truck A — the job's updatedAt moves forward.
    const firstAssign = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetA.body.id, expectedUpdatedAt: staleToken })
      .expect(201);
    expect(firstAssign.body.assetId).toBe(assetA.body.id);

    // Dispatcher 2, still holding the original version, is rejected rather than
    // clobbering Truck A with Truck B.
    const conflict = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetB.body.id, expectedUpdatedAt: staleToken })
      .expect(409);
    expect(conflict.body.error.code).toBe('JOB_MODIFIED');

    // The job still reflects dispatcher 1's assignment, untouched.
    const current = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(current.body.assetId).toBe(assetA.body.id);

    // Re-reading and retrying with the fresh token succeeds.
    const retry = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: assetB.body.id, expectedUpdatedAt: current.body.updatedAt })
      .expect(201);
    expect(retry.body.assetId).toBe(assetB.body.id);
  });
});
