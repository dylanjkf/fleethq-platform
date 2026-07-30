/**
 * Maintenance schedules: savable templates deployed to assets as per-asset
 * plans, derived overdue/due-soon status, "mark serviced" resetting the clock,
 * and the overdue plan dragging the asset's health score down. Time-based v1.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MANAGE = [PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_EDIT, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE];
const ownerPrisma = new PrismaClient();

describe('Maintenance schedules (templates + deployable plans)', () => {
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

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
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

  it('deploys a template to two trucks and derives plan status', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    const truckA = await createAsset(token, 'Truck A');
    const truckB = await createAsset(token, 'Truck B');

    const preset = await request(app.getHttpServer()).get('/v1/maintenance-schedules/presets').set(auth).expect(200);
    expect(preset.body.items.length).toBeGreaterThan(0);

    const template = await request(app.getHttpServer())
      .post('/v1/maintenance-schedules/templates')
      .set(auth)
      .send({ name: 'Std', items: [{ label: 'Service', intervalDays: 90 }, { label: 'Inspection', intervalDays: 365 }] })
      .expect(201);

    // Deploy to both trucks: 2 items × 2 assets = 4 plans.
    const deploy = await request(app.getHttpServer())
      .post(`/v1/maintenance-schedules/templates/${template.body.id}/deploy`)
      .set(auth)
      .send({ assetIds: [truckA, truckB] })
      .expect(201);
    expect(deploy.body.assetsTargeted).toBe(2);
    expect(deploy.body.plansCreated).toBe(4);

    // Re-deploy is idempotent (no duplicates).
    const redeploy = await request(app.getHttpServer())
      .post(`/v1/maintenance-schedules/templates/${template.body.id}/deploy`)
      .set(auth)
      .send({ assetIds: [truckA] })
      .expect(201);
    expect(redeploy.body.plansCreated).toBe(0);

    const plans = await request(app.getHttpServer()).get('/v1/maintenance-schedules/plans').set(auth).expect(200);
    expect(plans.body.items).toHaveLength(4);
    // Fresh plans (baseline = now) are 'ok', not overdue.
    expect(plans.body.overdueCount).toBe(0);

    // Template lists its deployed-plan count.
    const templates = await request(app.getHttpServer()).get('/v1/maintenance-schedules/templates').set(auth).expect(200);
    expect(templates.body.items[0]._count.plans).toBe(4);
  });

  it('flags an overdue plan, then mark-serviced clears it', async () => {
    const tenant = await createTestTenant(MANAGE);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    const truck = await createAsset(token, 'Old Timer');

    // A plan last serviced 200 days ago with a 90-day interval → overdue.
    const created = await request(app.getHttpServer())
      .post('/v1/maintenance-schedules/plans')
      .set(auth)
      .send({ assetId: truck, label: 'Service', intervalDays: 90, lastServiceAt: new Date(Date.now() - 200 * 86400000).toISOString() })
      .expect(201);
    expect(created.body.status).toBe('overdue');

    // Mark serviced → back to ok.
    const serviced = await request(app.getHttpServer()).post(`/v1/maintenance-schedules/plans/${created.body.id}/service`).set(auth).expect(201);
    expect(serviced.body.status).toBe('ok');
  });

  it('requires maintenance:edit to create a template', async () => {
    const viewer = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW]);
    const token = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post('/v1/maintenance-schedules/templates')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X', items: [{ label: 'Y', intervalDays: 30 }] })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.MAINTENANCE_EDIT);
  });
});
