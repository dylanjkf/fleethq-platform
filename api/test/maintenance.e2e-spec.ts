/**
 * Workshop milestone: manual maintenance job logging, the linear status
 * lifecycle, approval as a recorded-but-non-blocking action, and the
 * close/terminal-state rejection pattern (mirrors Dispatch's Job lifecycle).
 */
import { INestApplication } from '@nestjs/common';
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

describe('Maintenance (Workshop milestone)', () => {
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

  it('logs a maintenance job, edits it, approves it, then closes it with resolution notes', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.MAINTENANCE_VIEW,
      PERMISSIONS.MAINTENANCE_CREATE,
      PERMISSIONS.MAINTENANCE_EDIT,
      PERMISSIONS.MAINTENANCE_APPROVE,
      PERMISSIONS.MAINTENANCE_CLOSE,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const token = await loginAndGetToken(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Workshop Test Truck' })
      .expect(201);

    const job = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, title: 'Brake pads worn' })
      .expect(201);
    expect(job.body.status).toBe('OPEN');

    const inProgress = await request(app.getHttpServer())
      .patch(`/v1/maintenance-jobs/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);
    expect(inProgress.body.status).toBe('IN_PROGRESS');

    const approved = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(approved.body.approvedAt).not.toBeNull();

    const reApprove = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(reApprove.body.error.code).toBe('ALREADY_APPROVED');

    const closed = await request(app.getHttpServer())
      .post(`/v1/maintenance-jobs/${job.body.id}/close`)
      .set('Authorization', `Bearer ${token}`)
      .send({ resolutionNotes: 'Replaced front pads, tested brakes.', partsCost: 120.5, laborCost: 80 })
      .expect(201);
    expect(closed.body.status).toBe('COMPLETE');
    expect(closed.body.resolutionNotes).toBe('Replaced front pads, tested brakes.');
    expect(closed.body.partsCost).toBe(120.5);
    expect(closed.body.laborCost).toBe(80);

    const editAfterClose = await request(app.getHttpServer())
      .patch(`/v1/maintenance-jobs/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should not apply' })
      .expect(409);
    expect(editAfterClose.body.error.code).toBe('MAINTENANCE_JOB_CLOSED');
  });

  it('is tenant-isolated and rejects a job against another company\'s asset', async () => {
    const allPerms = [PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_CREATE, PERMISSIONS.ASSETS_CREATE];
    const tenantA = await createTestTenant(allPerms);
    const tenantB = await createTestTenant(allPerms);
    const tokenA = await loginAndGetToken(tenantA.username);
    const tokenB = await loginAndGetToken(tenantB.username);

    const assetB = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Company B Truck' })
      .expect(201);

    const crossTenant = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ assetId: assetB.body.id, title: 'Should not be creatable' })
      .expect(404);
    expect(crossTenant.body.error.code).toBe('ASSET_NOT_FOUND');

    const assetA = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Company A Truck' })
      .expect(201);
    const jobA = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ assetId: assetA.body.id, title: 'Company A only job' })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/v1/maintenance-jobs/${jobA.body.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('rejects maintenance:create without the permission', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.ASSETS_CREATE]);
    const token = await loginAndGetToken(viewOnly.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Truck' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, title: 'Should not be created' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.MAINTENANCE_CREATE);
  });
});
