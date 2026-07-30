/**
 * Operational Recommendations (09-AI/Fleet_Intelligence_Overview.md): two
 * deterministic rankings — which asset is best suited for a job (penalised for
 * open maintenance, expiring compliance, and being busy), and which open
 * maintenance job should be prioritized (fault age + whether the asset is
 * currently in use). No AI/ML model; suggestions only.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.ASSETS_VIEW,
  PERMISSIONS.MAINTENANCE_CREATE,
  PERMISSIONS.MAINTENANCE_VIEW,
  PERMISSIONS.COMPLIANCE_VIEW,
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_ASSIGN,
];

describe('Operational Recommendations', () => {
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

  async function createAsset(token: string, name: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name }).expect(201);
    return res.body.id;
  }

  it('ranks a clean asset above one with an open maintenance fault', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const cleanAsset = await createAsset(token, 'Clean Asset');
    const faultyAsset = await createAsset(token, 'Faulty Asset');
    await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: faultyAsset, title: 'Engine warning light' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/assets-for-job')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const clean = res.body.find((r: { assetId: string }) => r.assetId === cleanAsset);
    const faulty = res.body.find((r: { assetId: string }) => r.assetId === faultyAsset);
    expect(clean.score).toBeGreaterThan(faulty.score);
    expect(faulty.reasons.some((r: string) => r.toLowerCase().includes('maintenance'))).toBe(true);
    expect(res.body[0].assetId).toBe(cleanAsset);
  });

  it('penalizes an asset already assigned to another open job, and excludeJobId exempts its own job', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const busyAsset = await createAsset(token, 'Busy Asset');
    const freeAsset = await createAsset(token, 'Free Asset');

    const jobA = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Job A' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${jobA.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: busyAsset })
      .expect(201);

    const withoutExclude = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/assets-for-job')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const busyEntry = withoutExclude.body.find((r: { assetId: string }) => r.assetId === busyAsset);
    const freeEntry = withoutExclude.body.find((r: { assetId: string }) => r.assetId === freeAsset);
    expect(busyEntry.isBusy).toBe(true);
    expect(freeEntry.isBusy).toBe(false);
    expect(freeEntry.score).toBeGreaterThan(busyEntry.score);

    const withExclude = await request(app.getHttpServer())
      .get(`/v1/operational-recommendations/assets-for-job?excludeJobId=${jobA.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const busyEntryExcluded = withExclude.body.find((r: { assetId: string }) => r.assetId === busyAsset);
    expect(busyEntryExcluded.isBusy).toBe(false);
  });

  it('ranks a fault on a currently-in-use asset above one on an idle asset', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const busyAsset = await createAsset(token, 'Busy Fault Asset');
    const idleAsset = await createAsset(token, 'Idle Fault Asset');

    const busyJob = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: busyAsset, title: 'Brake wear' })
      .expect(201);
    const idleJob = await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: idleAsset, title: 'Loose mirror' })
      .expect(201);

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Keeps busyAsset busy' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: busyAsset })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/maintenance-priority')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const busy = res.body.find((r: { maintenanceJobId: string }) => r.maintenanceJobId === busyJob.body.id);
    const idle = res.body.find((r: { maintenanceJobId: string }) => r.maintenanceJobId === idleJob.body.id);

    expect(busy.currentlyInUse).toBe(true);
    expect(idle.currentlyInUse).toBe(false);
    expect(busy.priorityScore).toBeGreaterThan(idle.priorityScore);
    expect(res.body[0].maintenanceJobId).toBe(busyJob.body.id);
  });

  it('requires dispatch:view / maintenance:view respectively, and is tenant-isolated', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await createAsset(token, 'Isolated Asset');
    await request(app.getHttpServer())
      .post('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: await createAsset(token, 'Isolated Asset 2'), title: 'Some fault' })
      .expect(201);

    const noPerm = await createTestTenant([]);
    const noPermToken = await login(noPerm.username);
    const deniedAssets = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/assets-for-job')
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
    expect(deniedAssets.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_VIEW);

    const deniedMaintenance = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/maintenance-priority')
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
    expect(deniedMaintenance.body.error.requiredPermission).toBe(PERMISSIONS.MAINTENANCE_VIEW);

    const other = await createTestTenant(FULL);
    const otherToken = await login(other.username);
    const otherAssets = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/assets-for-job')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(otherAssets.body).toHaveLength(0);
    const otherMaintenance = await request(app.getHttpServer())
      .get('/v1/operational-recommendations/maintenance-priority')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    expect(otherMaintenance.body).toHaveLength(0);
  });
});
