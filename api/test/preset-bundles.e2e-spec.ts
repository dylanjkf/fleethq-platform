/**
 * Notification-preset bundles and dashboard-layout presets — both Saved
 * Layouts: an admin saves a configuration and deploys it to many company
 * members at once. Covers deploy writing each member's own settings, a
 * cross-tenant member being ignored, and the permission gates.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, addUserToCompany, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Preset bundles (notifications + dashboard)', () => {
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

  it('deploys a notification preset to company members, changing their own preferences', async () => {
    const admin = await createTestTenant([PERMISSIONS.NOTIFICATIONS_MANAGE]);
    const adminToken = await login(admin.username);
    const auth = { Authorization: `Bearer ${adminToken}` };

    // A member who can read their own notification preferences.
    const member = await addUserToCompany(admin.companyId, [PERMISSIONS.MESSAGES_VIEW]);
    const memberToken = await login(member.username);
    const memberAuth = { Authorization: `Bearer ${memberToken}` };

    // Baseline: member is not digest-only, nothing muted.
    const before = await request(app.getHttpServer()).get('/v1/notifications/preferences').set(memberAuth).expect(200);
    expect(before.body.digestOnly).toBe(false);
    expect(before.body.mutedTypes).toEqual([]);

    const preset = await request(app.getHttpServer())
      .post('/v1/notification-presets')
      .set(auth)
      .send({ name: 'Quiet drivers', digestOnly: true, mutedTypes: ['message', 'job_assigned'] })
      .expect(201);

    const deploy = await request(app.getHttpServer())
      .post(`/v1/notification-presets/${preset.body.id}/deploy`)
      .set(auth)
      .send({ userIds: [member.userId] })
      .expect(201);
    expect(deploy.body.applied).toBe(1);

    const after = await request(app.getHttpServer()).get('/v1/notifications/preferences').set(memberAuth).expect(200);
    expect(after.body.digestOnly).toBe(true);
    expect(after.body.mutedTypes.sort()).toEqual(['job_assigned', 'message']);
  });

  it('ignores a user id that is not a member of the company', async () => {
    const admin = await createTestTenant([PERMISSIONS.NOTIFICATIONS_MANAGE]);
    const adminToken = await login(admin.username);
    const auth = { Authorization: `Bearer ${adminToken}` };
    const outsider = await createTestTenant([PERMISSIONS.NOTIFICATIONS_MANAGE]); // different company

    const preset = await request(app.getHttpServer()).post('/v1/notification-presets').set(auth).send({ name: 'P', digestOnly: true }).expect(201);
    const deploy = await request(app.getHttpServer())
      .post(`/v1/notification-presets/${preset.body.id}/deploy`)
      .set(auth)
      .send({ userIds: [outsider.userId] })
      .expect(201);
    expect(deploy.body.applied).toBe(0);
  });

  it('saves a dashboard layout, makes a preset, and deploys it to members', async () => {
    const admin = await createTestTenant([PERMISSIONS.DASHBOARD_MANAGE]);
    const adminToken = await login(admin.username);
    const auth = { Authorization: `Bearer ${adminToken}` };
    const member = await addUserToCompany(admin.companyId, []);
    const memberToken = await login(member.username);
    const memberAuth = { Authorization: `Bearer ${memberToken}` };

    // Default layout is the full catalog, all visible.
    const myLayout = await request(app.getHttpServer()).get('/v1/dashboard/layout').set(auth).expect(200);
    expect(myLayout.body.widgets.length).toBe(myLayout.body.catalog.length);
    expect(myLayout.body.widgets.every((w: { visible: boolean }) => w.visible)).toBe(true);

    // Save a trimmed arrangement (hide two, reorder).
    const trimmed = [
      { key: 'company_status', visible: true },
      { key: 'count_fleet', visible: true },
      { key: 'recent_activity', visible: false },
    ];
    const saved = await request(app.getHttpServer()).put('/v1/dashboard/layout').set(auth).send({ widgets: trimmed }).expect(200);
    // Normalized: known-first in order, then the rest of the catalog appended visible.
    expect(saved.body.widgets[0].key).toBe('company_status');
    expect(saved.body.widgets.find((w: { key: string }) => w.key === 'recent_activity').visible).toBe(false);

    const preset = await request(app.getHttpServer())
      .post('/v1/dashboard/layout-presets')
      .set(auth)
      .send({ name: 'Dispatcher view', widgets: trimmed })
      .expect(201);

    const deploy = await request(app.getHttpServer())
      .post(`/v1/dashboard/layout-presets/${preset.body.id}/deploy`)
      .set(auth)
      .send({ userIds: [member.userId] })
      .expect(201);
    expect(deploy.body.applied).toBe(1);

    const memberLayout = await request(app.getHttpServer()).get('/v1/dashboard/layout').set(memberAuth).expect(200);
    expect(memberLayout.body.widgets[0].key).toBe('company_status');
    expect(memberLayout.body.widgets.find((w: { key: string }) => w.key === 'recent_activity').visible).toBe(false);
  });

  it('gates preset management behind the manage permissions', async () => {
    const plain = await createTestTenant([PERMISSIONS.MESSAGES_VIEW]);
    const token = await login(plain.username);
    const n = await request(app.getHttpServer()).post('/v1/notification-presets').set('Authorization', `Bearer ${token}`).send({ name: 'X' }).expect(403);
    expect(n.body.error.requiredPermission).toBe(PERMISSIONS.NOTIFICATIONS_MANAGE);
    const d = await request(app.getHttpServer()).post('/v1/dashboard/layout-presets').set('Authorization', `Bearer ${token}`).send({ name: 'X', widgets: [{ key: 'count_fleet', visible: true }] }).expect(403);
    expect(d.body.error.requiredPermission).toBe(PERMISSIONS.DASHBOARD_MANAGE);
  });
});
