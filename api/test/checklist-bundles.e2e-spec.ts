/**
 * Checklist/inspection bundles (Saved Layout): group checklist templates and
 * deploy the whole set to an asset class in one action (scoping each member
 * template to it). Covers create/list, deploy re-scoping every template, and
 * the permission gate.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MANAGE = [PERMISSIONS.CHECKLISTS_VIEW, PERMISSIONS.CHECKLISTS_CREATE, PERMISSIONS.CHECKLISTS_EDIT, PERMISSIONS.CHECKLISTS_ARCHIVE];
const ITEMS = [{ id: 'lights', label: 'Lights work', type: 'pass_fail' }];

describe('Checklist bundles', () => {
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
  async function makeTemplate(auth: Record<string, string>, name: string, appliesTo?: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/v1/checklist-templates')
      .set(auth)
      .send({ name, items: ITEMS, ...(appliesTo ? { appliesToAssetClass: appliesTo } : {}) })
      .expect(201);
    return res.body.id as string;
  }

  it('bundles templates and deploys them to an asset class in one action', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    // Two templates initially scoped to LAND.
    const t1 = await makeTemplate(auth, 'Pre-start', 'LAND');
    const t2 = await makeTemplate(auth, 'Weekly inspection', 'LAND');

    const bundle = await request(app.getHttpServer())
      .post('/v1/checklist-bundles')
      .set(auth)
      .send({ name: 'Truck bundle', description: 'Daily + weekly', templateIds: [t1, t2] })
      .expect(201);
    expect(bundle.body.templates).toHaveLength(2);

    const list = await request(app.getHttpServer()).get('/v1/checklist-bundles').set(auth).expect(200);
    expect(list.body.items.map((b: { id: string }) => b.id)).toContain(bundle.body.id);

    // Deploy the bundle to AIR — every template is re-scoped to AIR.
    const deploy = await request(app.getHttpServer())
      .post(`/v1/checklist-bundles/${bundle.body.id}/deploy`)
      .set(auth)
      .send({ assetClass: 'AIR' })
      .expect(201);
    expect(deploy.body.scoped).toBe(2);

    const templates = await request(app.getHttpServer()).get('/v1/checklist-templates').set(auth).expect(200);
    const scoped = templates.body.items.filter((t: { id: string }) => t.id === t1 || t.id === t2);
    expect(scoped.every((t: { appliesToAssetClass: { key: string } | null }) => t.appliesToAssetClass?.key === 'AIR')).toBe(true);
  });

  it('lets a bundle drop and replace its templates', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    const t1 = await makeTemplate(auth, 'A');
    const t2 = await makeTemplate(auth, 'B');

    const bundle = await request(app.getHttpServer()).post('/v1/checklist-bundles').set(auth).send({ name: 'Bundle', templateIds: [t1] }).expect(201);
    const updated = await request(app.getHttpServer()).patch(`/v1/checklist-bundles/${bundle.body.id}`).set(auth).send({ templateIds: [t1, t2] }).expect(200);
    expect(updated.body.templates.map((t: { id: string }) => t.id).sort()).toEqual([t1, t2].sort());
  });

  it('requires checklists:edit to create a bundle', async () => {
    const viewer = await createTestTenant([PERMISSIONS.CHECKLISTS_VIEW]);
    const token = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post('/v1/checklist-bundles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', templateIds: ['00000000-0000-4000-8000-000000000000'] })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.CHECKLISTS_EDIT);
  });
});
