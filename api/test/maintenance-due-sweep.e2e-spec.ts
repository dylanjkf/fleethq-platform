/**
 * Maintenance-due alert sweep: the leader-elected scheduler's per-company job
 * that raises an in-app notification the first time a per-asset maintenance
 * plan crosses into "due soon" or "overdue". The exact counterpart to the
 * compliance-expiry sweep — proves the right alerts fire, that they fan out to
 * maintenance:view holders, and that the sweep is idempotent (a second run
 * raises nothing new).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { MaintenanceSchedulesService } from '../src/maintenance-schedules/maintenance-schedules.service';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

describe('Maintenance due sweep', () => {
  let app: INestApplication;
  let maintenance: MaintenanceSchedulesService;

  beforeAll(async () => {
    app = await buildTestApp();
    maintenance = app.get(MaintenanceSchedulesService);
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<Record<string, string>> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  async function createAsset(auth: Record<string, string>, name: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name }).expect(201);
    return res.body.id as string;
  }

  async function createPlan(auth: Record<string, string>, assetId: string, label: string, intervalDays: number, lastServiceAt: string): Promise<void> {
    await request(app.getHttpServer())
      .post('/v1/maintenance-schedules/plans')
      .set(auth)
      .send({ assetId, label, intervalDays, lastServiceAt })
      .expect(201);
  }

  it('alerts on newly due/overdue plans once, and is idempotent + ok-safe', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.MAINTENANCE_VIEW,
      PERMISSIONS.MAINTENANCE_EDIT,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const auth = await login(tenant.username);
    const assetId = await createAsset(auth, 'Sweep Truck');

    // Due soon (serviced 80d ago on a 90d interval → due in ~10d), overdue
    // (serviced 200d ago on a 90d interval), and ok (serviced today on a 365d
    // interval).
    await createPlan(auth, assetId, 'Service', 90, daysAgo(80));
    await createPlan(auth, assetId, 'Inspection', 90, daysAgo(200));
    await createPlan(auth, assetId, 'Registration', 365, daysAgo(0));

    const first = await maintenance.sweepDue(tenant.companyId);
    expect(first).toEqual({ due: 1, overdue: 1 });

    // The maintenance:view holder got exactly the two alerts (ok plan silent).
    const listed = await request(app.getHttpServer()).get('/v1/notifications').set(auth).expect(200);
    const types = (listed.body.items as { type: string }[]).map((n) => n.type).sort();
    expect(types).toEqual(['maintenance_due', 'maintenance_overdue']);

    // Idempotent: a second sweep raises nothing, and no new notifications land.
    const second = await maintenance.sweepDue(tenant.companyId);
    expect(second).toEqual({ due: 0, overdue: 0 });
    const listedAgain = await request(app.getHttpServer()).get('/v1/notifications').set(auth).expect(200);
    expect((listedAgain.body.items as unknown[]).length).toBe(2);
  });

  it('re-alerts after a plan is serviced (a fresh service cycle)', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.MAINTENANCE_VIEW,
      PERMISSIONS.MAINTENANCE_EDIT,
      PERMISSIONS.ASSETS_CREATE,
    ]);
    const auth = await login(tenant.username);
    const assetId = await createAsset(auth, 'Cycle Truck');

    // Overdue plan → first sweep alerts once.
    const created = await request(app.getHttpServer())
      .post('/v1/maintenance-schedules/plans')
      .set(auth)
      .send({ assetId, label: 'Service', intervalDays: 30, lastServiceAt: daysAgo(60) })
      .expect(201);
    const planId = created.body.id as string;

    expect(await maintenance.sweepDue(tenant.companyId)).toEqual({ due: 0, overdue: 1 });
    // Servicing resets the clock AND the alert marks.
    await request(app.getHttpServer()).post(`/v1/maintenance-schedules/plans/${planId}/service`).set(auth).expect(201);
    // Freshly serviced → not yet due, so the immediate next sweep is silent.
    expect(await maintenance.sweepDue(tenant.companyId)).toEqual({ due: 0, overdue: 0 });

    // Push the plan back into "overdue" by rewinding last-service beyond the
    // interval; the reset marks mean the next sweep alerts again.
    await request(app.getHttpServer())
      .patch(`/v1/maintenance-schedules/plans/${planId}`)
      .set(auth)
      .send({ lastServiceAt: daysAgo(60) })
      .expect(200);
    expect(await maintenance.sweepDue(tenant.companyId)).toEqual({ due: 0, overdue: 1 });
  });

  it('is tenant-scoped — a sweep never alerts another company', async () => {
    const a = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW, PERMISSIONS.MAINTENANCE_EDIT, PERMISSIONS.ASSETS_CREATE]);
    const b = await createTestTenant([PERMISSIONS.MAINTENANCE_VIEW]);
    const authA = await login(a.username);
    const authB = await login(b.username);

    const assetId = await createAsset(authA, 'A Truck');
    await createPlan(authA, assetId, 'Service', 30, daysAgo(60));

    await maintenance.sweepDue(a.companyId);

    // Company B holds maintenance:view but had nothing swept — no alerts.
    const listedB = await request(app.getHttpServer()).get('/v1/notifications').set(authB).expect(200);
    expect((listedB.body.items as unknown[]).length).toBe(0);
  });
});
