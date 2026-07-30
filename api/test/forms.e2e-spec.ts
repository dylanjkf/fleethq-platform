/**
 * Universal Forms (01-Product/Universal_Forms.md) scoped slice: a data-driven
 * form builder (text/number/select/date/asset & operator reference fields,
 * single-level conditional show/hide) sharing Smart Checklists' versioned
 * template + immutable snapshot-submission pattern.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.FORMS_VIEW,
  PERMISSIONS.FORMS_CREATE,
  PERMISSIONS.FORMS_EDIT,
  PERMISSIONS.FORMS_ARCHIVE,
  PERMISSIONS.FORMS_SUBMIT,
  PERMISSIONS.ASSETS_CREATE,
  PERMISSIONS.OPERATORS_CREATE,
  PERMISSIONS.TIMELINE_VIEW,
];

describe('Universal Forms', () => {
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

  function basicField(overrides: Partial<Record<string, unknown>> = {}) {
    return { id: 'name', label: 'Name', type: 'text', required: true, ...overrides };
  }

  it('creates a form template with mixed field types and lists it', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Incident Report',
        targetContext: 'DRIVER',
        fields: [
          { id: 'summary', label: 'Summary', type: 'text', required: true },
          { id: 'severity', label: 'Severity', type: 'single_select', required: true, options: ['LOW', 'MEDIUM', 'HIGH'] },
          { id: 'injury', label: 'Injury involved?', type: 'single_select', required: true, options: ['YES', 'NO'] },
          { id: 'injuryDetail', label: 'Injury detail', type: 'text', required: true, showIfFieldId: 'injury', showIfValue: 'YES' },
        ],
      })
      .expect(201);
    expect(created.body.name).toBe('Incident Report');
    expect(created.body.targetContext).toBe('DRIVER');
    expect(created.body.version).toBe(1);
    expect(created.body.fields).toHaveLength(4);

    const list = await request(app.getHttpServer()).get('/v1/form-templates').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.some((t: { id: string }) => t.id === created.body.id)).toBe(true);
  });

  it('rejects a select field with no options, and a condition referencing a later field', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const noOptions = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Form', fields: [{ id: 'a', label: 'A', type: 'single_select', required: false }] })
      .expect(400);
    expect(noOptions.body.error.code).toBe('FORM_FIELD_OPTIONS_REQUIRED');

    const forwardRef = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Bad Form 2',
        fields: [
          { id: 'a', label: 'A', type: 'text', showIfFieldId: 'b', showIfValue: 'x' },
          { id: 'b', label: 'B', type: 'text' },
        ],
      })
      .expect(400);
    expect(forwardRef.body.error.code).toBe('FORM_INVALID_CONDITION');
  });

  it('bumps the version only on a field content change, not on a rename', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const created = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'V1 Form', fields: [basicField()] })
      .expect(201);

    const renamed = await request(app.getHttpServer())
      .patch(`/v1/form-templates/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed Form' })
      .expect(200);
    expect(renamed.body.version).toBe(1);

    const contentEdited = await request(app.getHttpServer())
      .patch(`/v1/form-templates/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ fields: [basicField(), { id: 'extra', label: 'Extra', type: 'text' }] })
      .expect(200);
    expect(contentEdited.body.version).toBe(2);
  });

  it('archives a form template', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const created = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'To Archive', fields: [basicField()] })
      .expect(201);

    const archived = await request(app.getHttpServer())
      .post(`/v1/form-templates/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);
    expect(archived.body.archivedAt).not.toBeNull();

    const list = await request(app.getHttpServer()).get('/v1/form-templates').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items.some((t: { id: string }) => t.id === created.body.id)).toBe(false);
  });

  it('submits a form referencing an asset and operator, writing Timeline events on both plus the submission', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Form Test Truck' }).expect(201);
    const operator = await request(app.getHttpServer()).post('/v1/operators').set('Authorization', `Bearer ${token}`).send({ fullName: 'Form Test Operator' }).expect(201);

    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Asset Inspection',
        fields: [
          { id: 'asset', label: 'Asset', type: 'asset_ref', required: true },
          { id: 'operator', label: 'Operator', type: 'operator_ref', required: true },
          { id: 'notes', label: 'Notes', type: 'text', required: false },
          { id: 'tags', label: 'Tags', type: 'multi_select', options: ['A', 'B', 'C'] },
        ],
      })
      .expect(201);

    const submission = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.body.id,
        templateVersion: template.body.version,
        templateSnapshot: template.body.fields,
        answers: [
          { fieldId: 'asset', value: asset.body.id },
          { fieldId: 'operator', value: operator.body.id },
          { fieldId: 'tags', value: ['A', 'C'] },
        ],
      })
      .expect(201);
    expect(submission.body.idempotentReplay).toBe(false);
    expect(submission.body.answers).toEqual([
      { fieldId: 'asset', value: asset.body.id },
      { fieldId: 'operator', value: operator.body.id },
      { fieldId: 'tags', value: ['A', 'C'] },
    ]);

    const assetTimeline = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'ASSET', entityId: asset.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(assetTimeline.body.items.some((e: { eventType: string }) => e.eventType === 'form_submitted')).toBe(true);

    const operatorTimeline = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'OPERATOR', entityId: operator.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(operatorTimeline.body.items.some((e: { eventType: string }) => e.eventType === 'form_submitted')).toBe(true);

    const submissionTimeline = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'FORM_SUBMISSION', entityId: submission.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(submissionTimeline.body.items).toHaveLength(1);
  });

  it('rejects a submission missing a required field', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Required Field Form', fields: [basicField()] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateId: template.body.id, templateVersion: template.body.version, templateSnapshot: template.body.fields, answers: [] })
      .expect(400);
    expect(res.body.error.code).toBe('FORM_FIELD_REQUIRED');
  });

  it('drops a conditionally-hidden field even if required, and even if a value was sent for it anyway', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Conditional Form',
        fields: [
          { id: 'injury', label: 'Injury involved?', type: 'single_select', required: true, options: ['YES', 'NO'] },
          { id: 'detail', label: 'Injury detail', type: 'text', required: true, showIfFieldId: 'injury', showIfValue: 'YES' },
        ],
      })
      .expect(201);

    // injury=NO hides `detail` — required but unanswered, and even a stray
    // answer for it should be dropped rather than persisted or validated.
    const submission = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.body.id,
        templateVersion: template.body.version,
        templateSnapshot: template.body.fields,
        answers: [
          { fieldId: 'injury', value: 'NO' },
          { fieldId: 'detail', value: 'should be dropped' },
        ],
      })
      .expect(201);
    expect(submission.body.answers).toEqual([{ fieldId: 'injury', value: 'NO' }]);

    // injury=YES makes `detail` visible and required.
    const rejected = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateId: template.body.id,
        templateVersion: template.body.version,
        templateSnapshot: template.body.fields,
        answers: [{ fieldId: 'injury', value: 'YES' }],
      })
      .expect(400);
    expect(rejected.body.error.code).toBe('FORM_FIELD_REQUIRED');
  });

  it('rejects a select value outside its declared options, and a reference to a nonexistent asset', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Validation Form',
        fields: [
          { id: 'severity', label: 'Severity', type: 'single_select', options: ['LOW', 'HIGH'] },
          { id: 'asset', label: 'Asset', type: 'asset_ref' },
        ],
      })
      .expect(201);

    const badOption = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateId: template.body.id, templateVersion: template.body.version, templateSnapshot: template.body.fields, answers: [{ fieldId: 'severity', value: 'NOT_AN_OPTION' }] })
      .expect(400);
    expect(badOption.body.error.code).toBe('FORM_INVALID_VALUE');

    const badAsset = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateId: template.body.id, templateVersion: template.body.version, templateSnapshot: template.body.fields, answers: [{ fieldId: 'asset', value: '00000000-0000-0000-0000-000000000000' }] })
      .expect(404);
    expect(badAsset.body.error.code).toBe('FORM_ASSET_NOT_FOUND');
  });

  it('is idempotent on a replayed submission id', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Idempotent Form', fields: [basicField({ required: false })] })
      .expect(201);

    const submissionId = randomUUID();
    const body = { id: submissionId, templateId: template.body.id, templateVersion: template.body.version, templateSnapshot: template.body.fields, answers: [] };

    const first = await request(app.getHttpServer()).post('/v1/form-submissions').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    expect(first.body.idempotentReplay).toBe(false);
    const replay = await request(app.getHttpServer()).post('/v1/form-submissions').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.id).toBe(submissionId);

    const list = await request(app.getHttpServer()).get('/v1/form-submissions').query({ templateId: template.body.id }).set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.total).toBe(1);
  });

  it('filters templates by targetContext, including BOTH-targeted ones', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    await request(app.getHttpServer()).post('/v1/form-templates').set('Authorization', `Bearer ${token}`).send({ name: 'Driver Only', targetContext: 'DRIVER', fields: [basicField()] }).expect(201);
    await request(app.getHttpServer()).post('/v1/form-templates').set('Authorization', `Bearer ${token}`).send({ name: 'Office Only', targetContext: 'OFFICE', fields: [basicField()] }).expect(201);
    await request(app.getHttpServer()).post('/v1/form-templates').set('Authorization', `Bearer ${token}`).send({ name: 'Both Contexts', targetContext: 'BOTH', fields: [basicField()] }).expect(201);

    const driverView = await request(app.getHttpServer()).get('/v1/form-templates').query({ targetContext: 'DRIVER' }).set('Authorization', `Bearer ${token}`).expect(200);
    const names = driverView.body.items.map((t: { name: string }) => t.name);
    expect(names).toContain('Driver Only');
    expect(names).toContain('Both Contexts');
    expect(names).not.toContain('Office Only');
  });

  it('requires forms:create/edit/archive/submit distinctly from forms:view', async () => {
    const admin = await createTestTenant(FULL);
    const adminToken = await login(admin.username);
    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Perm Test Form', fields: [basicField({ required: false })] })
      .expect(201);

    const viewOnly = await createTestTenant([PERMISSIONS.FORMS_VIEW]);
    const token = await login(viewOnly.username);

    const createRes = await request(app.getHttpServer()).post('/v1/form-templates').set('Authorization', `Bearer ${token}`).send({ name: 'X', fields: [basicField()] }).expect(403);
    expect(createRes.body.error.requiredPermission).toBe(PERMISSIONS.FORMS_CREATE);

    const editRes = await request(app.getHttpServer()).patch(`/v1/form-templates/${template.body.id}`).set('Authorization', `Bearer ${token}`).send({ name: 'Y' }).expect(403);
    expect(editRes.body.error.requiredPermission).toBe(PERMISSIONS.FORMS_EDIT);

    const archiveRes = await request(app.getHttpServer()).post(`/v1/form-templates/${template.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(403);
    expect(archiveRes.body.error.requiredPermission).toBe(PERMISSIONS.FORMS_ARCHIVE);

    const submitRes = await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ templateId: template.body.id, templateVersion: template.body.version, templateSnapshot: template.body.fields, answers: [] })
      .expect(403);
    expect(submitRes.body.error.requiredPermission).toBe(PERMISSIONS.FORMS_SUBMIT);
  });

  it("never surfaces another company's templates or submissions", async () => {
    const tenantA = await createTestTenant(FULL);
    const tokenA = await login(tenantA.username);
    const template = await request(app.getHttpServer())
      .post('/v1/form-templates')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Isolated Form', fields: [basicField({ required: false })] })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ templateId: template.body.id, templateVersion: template.body.version, templateSnapshot: template.body.fields, answers: [] })
      .expect(201);

    const tenantB = await createTestTenant(FULL);
    const tokenB = await login(tenantB.username);

    const list = await request(app.getHttpServer()).get('/v1/form-templates').set('Authorization', `Bearer ${tokenB}`).expect(200);
    expect(list.body.items.some((t: { id: string }) => t.id === template.body.id)).toBe(false);

    await request(app.getHttpServer()).get(`/v1/form-templates/${template.body.id}`).set('Authorization', `Bearer ${tokenB}`).expect(404);

    // Cannot submit against a template that isn't visible in this tenant either.
    await request(app.getHttpServer())
      .post('/v1/form-submissions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ templateId: template.body.id, templateVersion: 1, templateSnapshot: template.body.fields, answers: [] })
      .expect(404);
  });
});
