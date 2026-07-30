/**
 * Customer-customizable fatigue rules: a company saves its own rule set (a
 * "savable layout"), deploys it to an operator, and the fatigue engine
 * evaluates that operator against the custom thresholds instead of the AU
 * default. Also covers the company-default fallback and permission gating.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createShift, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS);
const MANAGE = [PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE, PERMISSIONS.FATIGUE_MANAGE];

describe('Fatigue rule sets (customer-customizable)', () => {
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

  it('deploys a custom rule set to an operator and evaluates against its thresholds', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const operator = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Strict Co Driver' }).expect(201);
    // A 9h shift in the last 24h — well under the AU 12h default (would be "ok").
    await createShift(tenant.companyId, operator.body.id, hoursAgo(10), hoursAgo(1));

    // Baseline: default rules → ok.
    const baseline = await request(app.getHttpServer()).get(`/v1/fatigue/operators/${operator.body.id}`).set(auth).expect(200);
    expect(baseline.body.status).toBe('ok');

    // Save a stricter custom rule set: 8h/24h max work.
    const set = await request(app.getHttpServer())
      .post('/v1/fatigue-rule-sets')
      .set(auth)
      .send({ name: 'Night shift — strict', maxWork24hMin: 8 * 60, minRest24hMin: 8 * 60, maxWork7dMin: 60 * 60, minRest7dMin: 24 * 60, approachingBufferMin: 60 })
      .expect(201);

    // Deploy it to the operator.
    const deploy = await request(app.getHttpServer())
      .post(`/v1/fatigue-rule-sets/${set.body.id}/deploy`)
      .set(auth)
      .send({ operatorIds: [operator.body.id] })
      .expect(201);
    expect(deploy.body.assigned).toBe(1);

    // Now the same 9h shift breaches the custom 8h limit.
    const after = await request(app.getHttpServer()).get(`/v1/fatigue/operators/${operator.body.id}`).set(auth).expect(200);
    expect(after.body.status).toBe('breach');
    expect(after.body.ruleSetName).toBe('Night shift — strict');
    expect(after.body.breaches.map((b: { rule: string }) => b.rule)).toContain('MAX_WORK_24H');
  });

  it('applies a company-default rule set to unassigned operators', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const operator = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Default Rules Driver' }).expect(201);
    await createShift(tenant.companyId, operator.body.id, hoursAgo(10), hoursAgo(1)); // 9h

    // Create a strict set and make it the company default (no per-operator assignment).
    await request(app.getHttpServer())
      .post('/v1/fatigue-rule-sets')
      .set(auth)
      .send({ name: 'House rules', maxWork24hMin: 8 * 60, minRest24hMin: 8 * 60, maxWork7dMin: 60 * 60, minRest7dMin: 24 * 60, approachingBufferMin: 60, isDefault: true })
      .expect(201);

    const res = await request(app.getHttpServer()).get(`/v1/fatigue/operators/${operator.body.id}`).set(auth).expect(200);
    expect(res.body.status).toBe('breach');
    expect(res.body.ruleSetName).toBe('House rules');
  });

  it('lists rule sets with their deployed-operator counts and offers the preset', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const preset = await request(app.getHttpServer()).get('/v1/fatigue-rule-sets/preset').set(auth).expect(200);
    expect(preset.body.maxWork24hMin).toBe(12 * 60);

    const set = await request(app.getHttpServer())
      .post('/v1/fatigue-rule-sets')
      .set(auth)
      .send({ name: 'A', maxWork24hMin: 600, minRest24hMin: 420, maxWork7dMin: 4320, minRest7dMin: 1440, approachingBufferMin: 60 })
      .expect(201);
    const op = await request(app.getHttpServer()).post('/v1/operators').set(auth).send({ fullName: 'Op' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/fatigue-rule-sets/${set.body.id}/deploy`).set(auth).send({ operatorIds: [op.body.id] }).expect(201);

    const list = await request(app.getHttpServer()).get('/v1/fatigue-rule-sets').set(auth).expect(200);
    const found = list.body.items.find((s: { id: string }) => s.id === set.body.id);
    expect(found._count.operators).toBe(1);
  });

  it('requires fatigue:manage to create a rule set', async () => {
    const viewer = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW]);
    const token = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post('/v1/fatigue-rule-sets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', maxWork24hMin: 600, minRest24hMin: 420, maxWork7dMin: 4320, minRest7dMin: 1440, approachingBufferMin: 60 })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.FATIGUE_MANAGE);
  });
});
