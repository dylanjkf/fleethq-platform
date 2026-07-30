/**
 * Smart Checklists milestone (01-Product/Smart_Checklists.md): versioned,
 * company-configurable pre-start templates + immutable operator submissions.
 * Covers the headline acceptance criterion (one "fail" answer produces a
 * workshop MaintenanceJob with no further data entry), template version
 * snapshotting (a later office edit never rewrites a completed checklist),
 * idempotent offline-replay of a submission, the fail→note-required branch,
 * tenant isolation, and route-level permission enforcement.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createOperatorLinkedToUser,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const MANAGE = [
  PERMISSIONS.CHECKLISTS_VIEW,
  PERMISSIONS.CHECKLISTS_CREATE,
  PERMISSIONS.CHECKLISTS_EDIT,
  PERMISSIONS.CHECKLISTS_ARCHIVE,
  PERMISSIONS.CHECKLISTS_SUBMIT,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.MAINTENANCE_VIEW,
];

const PRESTART_ITEMS = [
  { id: 'lights', label: 'Lights and indicators working', type: 'pass_fail' },
  { id: 'tyres', label: 'Tyres undamaged', type: 'pass_fail', requireNoteOnFail: true, createsFaultOnFail: true },
  { id: 'firstaid', label: 'First-aid kit present', type: 'pass_fail_na' },
];

describe('Smart Checklists (Smart Checklists milestone)', () => {
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

  async function createAsset(token: string, name: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name })
      .expect(201);
    return res.body.id as string;
  }

  async function createTemplate(
    token: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; version: number; items: unknown[]; name: string; appliesToAssetClass: { key: string } | null }> {
    const res = await request(app.getHttpServer())
      .post('/v1/checklist-templates')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    return res.body;
  }

  it('creates a template, bumps version only on content edits, and archives it', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);

    const template = await createTemplate(token, {
      name: 'Daily Pre-Start',
      appliesToAssetClass: 'LAND',
      items: PRESTART_ITEMS,
    });
    expect(template.version).toBe(1);
    expect(template.appliesToAssetClass?.key).toBe('LAND');

    // Editing content bumps the version.
    const v2 = await request(app.getHttpServer())
      .patch(`/v1/checklist-templates/${template.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [...PRESTART_ITEMS, { id: 'horn', label: 'Horn works', type: 'pass_fail' }] })
      .expect(200);
    expect(v2.body.version).toBe(2);

    // Renaming alone does not bump the version.
    const renamed = await request(app.getHttpServer())
      .patch(`/v1/checklist-templates/${template.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Daily Pre-Start (AU)' })
      .expect(200);
    expect(renamed.body.version).toBe(2);
    expect(renamed.body.name).toBe('Daily Pre-Start (AU)');

    await request(app.getHttpServer())
      .post(`/v1/checklist-templates/${template.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const activeList = await request(app.getHttpServer())
      .get('/v1/checklist-templates')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(activeList.body.items.map((t: { id: string }) => t.id)).not.toContain(template.id);

    const withArchived = await request(app.getHttpServer())
      .get('/v1/checklist-templates?includeArchived=true')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(withArchived.body.items.map((t: { id: string }) => t.id)).toContain(template.id);
  });

  it('resolves the applicable template for an asset by its class', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    const assetId = await createAsset(token, 'Land Truck');

    const landTemplate = await createTemplate(token, {
      name: 'Land Pre-Start',
      appliesToAssetClass: 'LAND',
      items: PRESTART_ITEMS,
    });
    const anyTemplate = await createTemplate(token, {
      name: 'Universal Safety Check',
      items: [{ id: 'seatbelt', label: 'Seatbelt fastened', type: 'pass_fail' }],
    });
    // An Air-scoped template must NOT surface for a Land asset.
    const airTemplate = await createTemplate(token, {
      name: 'Air Pre-Flight',
      appliesToAssetClass: 'AIR',
      items: [{ id: 'wings', label: 'Wings attached', type: 'pass_fail' }],
    });

    const applicable = await request(app.getHttpServer())
      .get(`/v1/checklist-templates?assetId=${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = applicable.body.items.map((t: { id: string }) => t.id);
    expect(ids).toContain(landTemplate.id);
    expect(ids).toContain(anyTemplate.id);
    expect(ids).not.toContain(airTemplate.id);
  });

  it('surfaces a directly-assigned template for an asset even when its class does not match', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    const assetId = await createAsset(token, 'Land Truck'); // LAND class

    // An AIR-scoped template would normally never apply to a Land asset...
    const airTemplate = await createTemplate(token, {
      name: 'Special Check',
      appliesToAssetClass: 'AIR',
      items: [{ id: 'x', label: 'Check X', type: 'pass_fail' }],
      // ...but assigning it directly to this asset makes it apply.
      assignedAssetIds: [assetId],
    });
    expect(airTemplate).toBeDefined();

    const applicable = await request(app.getHttpServer())
      .get(`/v1/checklist-templates?assetId=${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(applicable.body.items.map((t: { id: string }) => t.id)).toContain(airTemplate.id);

    // Clearing the assignment removes it again.
    await request(app.getHttpServer())
      .patch(`/v1/checklist-templates/${airTemplate.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assignedAssetIds: [] })
      .expect(200);
    const after = await request(app.getHttpServer())
      .get(`/v1/checklist-templates?assetId=${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.items.map((t: { id: string }) => t.id)).not.toContain(airTemplate.id);
  });

  it('accepts a written-answer (text) item and stores the response with no pass/fail', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Dana Driver');
    const assetId = await createAsset(token, 'Truck 9');

    const template = await createTemplate(token, {
      name: 'Reading Check',
      appliesToAssetClass: 'LAND',
      items: [
        { id: 'lights', label: 'Lights working', type: 'pass_fail' },
        { id: 'odo', label: 'Odometer reading', type: 'text' },
      ],
    });

    // A text item with no written answer is "unanswered" and rejected.
    await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId,
        answers: [{ itemId: 'lights', status: 'pass' }, { itemId: 'odo', note: '' }],
      })
      .expect(400);

    const submission = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId,
        answers: [
          { itemId: 'lights', status: 'pass' },
          { itemId: 'odo', note: '184320 km' },
        ],
      })
      .expect(201);

    expect(submission.body.hasFailures).toBe(false);
    const odo = submission.body.answers.find((a: { itemId: string }) => a.itemId === 'odo');
    expect(odo.status).toBeNull();
    expect(odo.note).toBe('184320 km');
  });

  it('submits a checklist: a "fail" spawns a workshop maintenance job, and asset/operator get timeline events', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    const operatorId = await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Dana Driver');
    const assetId = await createAsset(token, 'Truck 7');

    const template = await createTemplate(token, {
      name: 'Daily Pre-Start',
      appliesToAssetClass: 'LAND',
      items: PRESTART_ITEMS,
    });

    const submission = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId,
        answers: [
          { itemId: 'lights', status: 'pass' },
          { itemId: 'tyres', status: 'fail', note: 'Front-left tyre gouged' },
          { itemId: 'firstaid', status: 'na' },
        ],
      })
      .expect(201);

    expect(submission.body.hasFailures).toBe(true);
    expect(submission.body.operator.id).toBe(operatorId);
    expect(submission.body.createdMaintenanceJobIds).toHaveLength(1);

    // The headline acceptance criterion: a workshop job now exists, no extra entry.
    const jobs = await request(app.getHttpServer())
      .get('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const autoJob = jobs.body.items.find((j: { id: string }) => j.id === submission.body.createdMaintenanceJobIds[0]);
    expect(autoJob).toBeDefined();
    expect(autoJob.title).toBe('Checklist fault: Tyres undamaged');
    expect(autoJob.reportedByOperatorId).toBe(operatorId);
  });

  it('records the template snapshot so a later office edit never rewrites a completed checklist', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    const assetId = await createAsset(token, 'Truck 8');
    const template = await createTemplate(token, {
      name: 'Pre-Start',
      appliesToAssetClass: 'LAND',
      items: [{ id: 'lights', label: 'Lights working', type: 'pass_fail' }],
    });

    const submission = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId,
        answers: [{ itemId: 'lights', status: 'pass' }],
      })
      .expect(201);

    // Office rewrites the template wording afterwards.
    await request(app.getHttpServer())
      .patch(`/v1/checklist-templates/${template.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ id: 'lights', label: 'COMPLETELY DIFFERENT WORDING', type: 'pass_fail' }] })
      .expect(200);

    const fetched = await request(app.getHttpServer())
      .get(`/v1/checklist-submissions/${submission.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(fetched.body.templateVersion).toBe(1);
    expect(fetched.body.templateSnapshot[0].label).toBe('Lights working');
  });

  it('is idempotent: replaying a submission id does not create a second checklist or second fault', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    await createOperatorLinkedToUser(tenant.companyId, tenant.userId);
    const assetId = await createAsset(token, 'Truck 9');
    const template = await createTemplate(token, {
      name: 'Pre-Start',
      appliesToAssetClass: 'LAND',
      items: [{ id: 'tyres', label: 'Tyres OK', type: 'pass_fail', createsFaultOnFail: true }],
    });

    const clientId = randomUUID();
    const body = {
      id: clientId,
      templateId: template.id,
      templateVersion: template.version,
      templateSnapshot: template.items,
      assetId,
      answers: [{ itemId: 'tyres', status: 'fail', note: 'flat' }],
    };

    const first = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    expect(first.body.idempotentReplay).toBe(false);
    expect(first.body.createdMaintenanceJobIds).toHaveLength(1);

    const replay = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(clientId);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.createdMaintenanceJobIds).toHaveLength(0);

    // Exactly one submission and one auto-created maintenance job survived.
    const list = await request(app.getHttpServer())
      .get(`/v1/checklist-submissions?assetId=${assetId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.items).toHaveLength(1);

    const jobs = await request(app.getHttpServer())
      .get('/v1/maintenance-jobs')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(jobs.body.items.filter((j: { assetId: string }) => j.assetId === assetId)).toHaveLength(1);
  });

  it('enforces the fail→note-required branch and rejects invalid answers', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    const assetId = await createAsset(token, 'Truck 10');
    const template = await createTemplate(token, {
      name: 'Pre-Start',
      appliesToAssetClass: 'LAND',
      items: PRESTART_ITEMS,
    });

    const base = {
      templateId: template.id,
      templateVersion: template.version,
      templateSnapshot: template.items,
      assetId,
    };

    const noNote = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...base,
        answers: [
          { itemId: 'lights', status: 'pass' },
          { itemId: 'tyres', status: 'fail' },
          { itemId: 'firstaid', status: 'na' },
        ],
      })
      .expect(400);
    expect(noNote.body.error.code).toBe('CHECKLIST_NOTE_REQUIRED');

    const badNa = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ...base,
        answers: [
          { itemId: 'lights', status: 'na' },
          { itemId: 'tyres', status: 'pass' },
          { itemId: 'firstaid', status: 'pass' },
        ],
      })
      .expect(400);
    expect(badNa.body.error.code).toBe('CHECKLIST_NA_NOT_ALLOWED');

    const incomplete = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...base, answers: [{ itemId: 'lights', status: 'pass' }] })
      .expect(400);
    expect(incomplete.body.error.code).toBe('CHECKLIST_INCOMPLETE');
  });

  it('is tenant-isolated across templates, submissions, and cross-tenant asset references', async () => {
    const tenantA = await createTestTenant(MANAGE);
    const tenantB = await createTestTenant(MANAGE);
    const tokenA = await loginAndGetToken(tenantA.username);
    const tokenB = await loginAndGetToken(tenantB.username);

    const templateB = await createTemplate(tokenB, {
      name: 'B Pre-Start',
      appliesToAssetClass: 'LAND',
      items: [{ id: 'lights', label: 'Lights', type: 'pass_fail' }],
    });
    const assetBId = await createAsset(tokenB, 'B Truck');

    // A cannot see B's template.
    await request(app.getHttpServer())
      .get(`/v1/checklist-templates/${templateB.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);

    // A cannot submit against B's template/asset.
    const cross = await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        templateId: templateB.id,
        templateVersion: 1,
        templateSnapshot: templateB.items,
        assetId: assetBId,
        answers: [{ itemId: 'lights', status: 'pass' }],
      })
      .expect(404);
    expect(cross.body.error.code).toBe('CHECKLIST_TEMPLATE_NOT_FOUND');
  });

  it("reports today's pre-start status per active asset", async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await loginAndGetToken(tenant.username);
    const doneAsset = await createAsset(token, 'Completed Truck');
    const pendingAsset = await createAsset(token, 'Pending Truck');
    const template = await createTemplate(token, {
      name: 'Pre-Start',
      appliesToAssetClass: 'LAND',
      items: [{ id: 'tyres', label: 'Tyres OK', type: 'pass_fail', createsFaultOnFail: true }],
    });

    await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId: doneAsset,
        answers: [{ itemId: 'tyres', status: 'fail', note: 'worn' }],
      })
      .expect(201);

    const status = await request(app.getHttpServer())
      .get('/v1/checklist-status/today')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const byId: Record<string, { status: string; hasFailures: boolean }> = Object.fromEntries(
      status.body.items.map((i: { asset: { id: string }; status: string; hasFailures: boolean }) => [
        i.asset.id,
        { status: i.status, hasFailures: i.hasFailures },
      ]),
    );
    expect(byId[doneAsset]).toEqual({ status: 'done', hasFailures: true });
    expect(byId[pendingAsset]).toEqual({ status: 'not_done', hasFailures: false });
    expect(status.body.summary.done).toBeGreaterThanOrEqual(1);
    expect(status.body.summary.withFailures).toBeGreaterThanOrEqual(1);
  });

  it('gates template management but lets any signed-in user submit regardless of role', async () => {
    // A role that can build templates + assets but deliberately lacks
    // checklists:submit.
    const noSubmit = await createTestTenant([
      PERMISSIONS.CHECKLISTS_VIEW,
      PERMISSIONS.CHECKLISTS_CREATE,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const token = await loginAndGetToken(noSubmit.username);
    const assetId = await createAsset(token, 'Truck');
    const template = await createTemplate(token, {
      name: 'T',
      appliesToAssetClass: 'LAND',
      items: [{ id: 'a', label: 'A', type: 'pass_fail' }],
    });

    // Submitting a checklist is intentionally NOT permission-gated — it succeeds
    // even though this role has no checklists:submit.
    await request(app.getHttpServer())
      .post('/v1/checklist-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId,
        answers: [{ itemId: 'a', status: 'pass' }],
      })
      .expect(201);

    // Template management is still gated: a view-only role can't create a template.
    const viewOnly = await createTestTenant([PERMISSIONS.CHECKLISTS_VIEW]);
    const viewToken = await loginAndGetToken(viewOnly.username);
    const denied = await request(app.getHttpServer())
      .post('/v1/checklist-templates')
      .set('Authorization', `Bearer ${viewToken}`)
      .send({ name: 'X', items: [{ id: 'a', label: 'A', type: 'pass_fail' }] })
      .expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.CHECKLISTS_CREATE);
  });
});
