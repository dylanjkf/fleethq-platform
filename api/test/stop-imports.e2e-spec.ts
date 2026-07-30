/**
 * Bulk stop import (manifest CSV, courier vertical): dry-run validates without
 * writing, commit creates ordered stops on the target job, a customerName
 * matches an existing Customer or creates one, and one bad row never blocks
 * the rows around it.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.CUSTOMERS_VIEW,
  PERMISSIONS.CUSTOMERS_CREATE,
  PERMISSIONS.ASSETS_CREATE,
];

describe('Bulk stop import', () => {
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

  async function makeJob(token: string) {
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Manifest run', assetId: asset.body.id }).expect(201);
    return job.body.id as string;
  }

  it('dry-runs without writing anything, then commits, matching/creating customers as it goes', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const jobId = await makeJob(token);

    // Pre-existing customer that one row should MATCH rather than duplicate.
    await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${token}`).send({ name: 'ACME Pty Ltd', address: 'Saved Address 1' }).expect(201);

    const rows = [
      { customerName: 'ACME Pty Ltd' }, // should match existing, use ITS saved address
      { customerName: 'New Customer Co', address: '5 New St' }, // should create a new customer
      { label: 'One-off drop-off', address: '9 Random Rd' }, // pure free text, no customer
    ];

    const dryRun = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/import`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows, dryRun: true })
      .expect(201);
    expect(dryRun.body.validCount).toBe(3);
    expect(dryRun.body.createdCount).toBe(0);

    // Nothing was written during dry run.
    const afterDryRun = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(afterDryRun.body.stops).toHaveLength(0);
    const customersAfterDryRun = await request(app.getHttpServer()).get('/v1/customers').set('Authorization', `Bearer ${token}`).expect(200);
    expect(customersAfterDryRun.body.total).toBe(1);

    const commit = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/import`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows, dryRun: false })
      .expect(201);
    expect(commit.body.createdCount).toBe(3);

    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(job.body.stops).toHaveLength(3);
    expect(job.body.stops[0].label).toBe('ACME Pty Ltd');
    expect(job.body.stops[0].address).toBe('Saved Address 1'); // matched customer's SAVED address wins, not overwritten
    expect(job.body.stops[1].label).toBe('New Customer Co');
    expect(job.body.stops[2].label).toBe('One-off drop-off');
    expect(job.body.stops[2].customerId).toBeNull();

    // Matching didn't create a duplicate; the new one did get created.
    const customersAfter = await request(app.getHttpServer()).get('/v1/customers').set('Authorization', `Bearer ${token}`).expect(200);
    expect(customersAfter.body.total).toBe(2);
  });

  it("doesn't let one bad row block the rows around it", async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const jobId = await makeJob(token);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/import`)
      .set('Authorization', `Bearer ${token}`)
      .send({ rows: [{ label: 'Good stop' }, {}, { label: 'Also good' }], dryRun: false })
      .expect(201);

    expect(res.body.total).toBe(3);
    expect(res.body.createdCount).toBe(2);
    expect(res.body.invalidCount).toBe(1);
    expect(res.body.rows[1].valid).toBe(false);

    const job = await request(app.getHttpServer()).get(`/v1/jobs/${jobId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(job.body.stops).toHaveLength(2);
  });

  it('requires dispatch:edit', async () => {
    const full = await createTestTenant(FULL);
    const fullToken = await login(full.username);
    const jobId = await makeJob(fullToken);
    const viewer = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const viewerToken = await login(viewer.username);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${jobId}/stops/import`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ rows: [{ label: 'x' }] })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_EDIT);
  });
});
