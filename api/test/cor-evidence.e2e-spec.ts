/**
 * Chain of Responsibility evidence pack (08-Compliance/Australian_Compliance.md):
 * assembles, for one Job, the scheduling decisions (Timeline events), the
 * assigned operator's fitness-for-duty signal (fatigue breach/override
 * events), and the assigned asset's condition (checklist results,
 * maintenance faults, compliance document validity as of the job's own
 * window) — using existing Timeline/entity data as the evidence trail
 * rather than a new stored record.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createShift,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * HOUR_MS);
}
function daysFromNow(d: number): string {
  return new Date(Date.now() + d * DAY_MS).toISOString();
}

const FULL = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_ASSIGN,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.CHECKLISTS_CREATE,
  PERMISSIONS.CHECKLISTS_SUBMIT,
  PERMISSIONS.MAINTENANCE_VIEW,
  PERMISSIONS.COMPLIANCE_VIEW,
  PERMISSIONS.COMPLIANCE_CREATE,
];

describe('Chain of Responsibility evidence pack', () => {
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

  it('assembles scheduling, operator fitness, and asset condition for a flagged job', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'CoR Test Truck' })
      .expect(201);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'CoR Test Operator' })
      .expect(201);

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'CoR Evidence Job' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);

    const template = await request(app.getHttpServer())
      .post('/v1/checklist-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'CoR Pre-Start',
        items: [{ id: 'tyres', label: 'Tyres undamaged', type: 'pass_fail', requireNoteOnFail: true, createsFaultOnFail: true }],
      })
      .expect(201);

    const submission = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.body.id,
        templateVersion: template.body.version,
        templateSnapshot: template.body.items,
        assetId: asset.body.id,
        answers: [{ itemId: 'tyres', status: 'fail', note: 'Worn tread' }],
      })
      .expect(201);
    expect(submission.body.createdMaintenanceJobIds).toHaveLength(1);

    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(-5) })
      .expect(201);

    const pack = await request(app.getHttpServer())
      .get(`/v1/compliance/cor-evidence/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(pack.body.job.assetName).toBe('CoR Test Truck');
    expect(pack.body.job.operatorName).toBe('CoR Test Operator');
    expect(pack.body.schedulingDecisions.some((e: { eventType: string }) => e.eventType === 'assigned')).toBe(true);
    expect(pack.body.assetCondition.checklistSubmissions).toHaveLength(1);
    expect(pack.body.assetCondition.checklistSubmissions[0].hasFailures).toBe(true);
    expect(pack.body.assetCondition.maintenanceFaults).toHaveLength(1);
    expect(pack.body.assetCondition.complianceDocuments).toHaveLength(1);
    expect(pack.body.assetCondition.complianceDocuments[0].expiryStatusAtTime).toBe('expired');
    expect(pack.body.hasConcerns).toBe(true);
  });

  it('reports no concerns for a clean job with a valid document and a passing checklist', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Clean Truck' })
      .expect(201);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Clean Operator' })
      .expect(201);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Clean Job' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(201);

    const template = await request(app.getHttpServer())
      .post('/v1/checklist-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Clean Pre-Start', items: [{ id: 'lights', label: 'Lights working', type: 'pass_fail' }] })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.body.id,
        templateVersion: template.body.version,
        templateSnapshot: template.body.items,
        assetId: asset.body.id,
        answers: [{ itemId: 'lights', status: 'pass' }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/compliance-documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, documentType: 'REGISTRATION', expiresAt: daysFromNow(90) })
      .expect(201);

    const pack = await request(app.getHttpServer())
      .get(`/v1/compliance/cor-evidence/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(pack.body.assetCondition.checklistSubmissions[0].hasFailures).toBe(false);
    expect(pack.body.assetCondition.maintenanceFaults).toHaveLength(0);
    expect(pack.body.assetCondition.complianceDocuments[0].expiryStatusAtTime).toBe('valid');
    expect(pack.body.operatorFitness).toHaveLength(0);
    expect(pack.body.hasConcerns).toBe(false);
  });

  it('surfaces a fatigue override in operatorFitness', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Fatigue CoR Truck' })
      .expect(201);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Fatigue CoR Operator' })
      .expect(201);
    await createShift(tenant.companyId, operator.body.id, hoursAgo(14), hoursAgo(1));

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Overridden Assignment Job' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id, acknowledgeFatigueRisk: true })
      .expect(201);

    const pack = await request(app.getHttpServer())
      .get(`/v1/compliance/cor-evidence/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(pack.body.operatorFitness.some((e: { eventType: string }) => e.eventType === 'fatigue_risk_overridden')).toBe(true);
    expect(pack.body.hasConcerns).toBe(true);
  });

  it('handles a job with no asset/operator assigned, and no checklists/faults/documents', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Unassigned Job' })
      .expect(201);

    const pack = await request(app.getHttpServer())
      .get(`/v1/compliance/cor-evidence/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(pack.body.job.assetId).toBeNull();
    expect(pack.body.job.operatorId).toBeNull();
    expect(pack.body.assetCondition.checklistSubmissions).toHaveLength(0);
    expect(pack.body.assetCondition.maintenanceFaults).toHaveLength(0);
    expect(pack.body.assetCondition.complianceDocuments).toHaveLength(0);
    expect(pack.body.operatorFitness).toHaveLength(0);
    expect(pack.body.hasConcerns).toBe(false);
  });

  it('404s for an unknown job, is gated on compliance:view, and is tenant-isolated', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Isolated Job' })
      .expect(201);

    const missing = await request(app.getHttpServer())
      .get('/v1/compliance/cor-evidence/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect(missing.body.error.code).toBe('JOB_NOT_FOUND');

    const noPerm = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const noPermToken = await login(noPerm.username);
    const denied = await request(app.getHttpServer())
      .get(`/v1/compliance/cor-evidence/${job.body.id}`)
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.COMPLIANCE_VIEW);

    const other = await createTestTenant(FULL);
    const otherToken = await login(other.username);
    const crossTenant = await request(app.getHttpServer())
      .get(`/v1/compliance/cor-evidence/${job.body.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    expect(crossTenant.body.error.code).toBe('JOB_NOT_FOUND');
  });
});
