/**
 * Warehouse add-on: stock inventory (create/list/adjust/import/archive) and
 * warehouse machines with maintenance/monitoring logs. Permission-gated
 * (warehouse:view/manage).
 *
 * This suite covers the *permission* dimension only, and runs with billing
 * enforcement off (the default), so the plan paywall is inert here — that's why
 * a plain warehouse:manage grant suffices throughout. The *entitlement*
 * dimension (402 FEATURE_NOT_IN_PLAN when the plan lacks the add-on) is covered
 * separately in `warehouse-paywall.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MANAGER = [PERMISSIONS.WAREHOUSE_VIEW, PERMISSIONS.WAREHOUSE_MANAGE];

describe('Warehouse (stock + machines)', () => {
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

  it('adds, lists, adjusts, imports, and archives stock', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const created = await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set(auth)
      .send({ name: 'Pallet wrap 500mm', sku: 'WRAP-500', category: 'Packaging', quantity: 40, unit: 'roll', minQuantity: 10, attributes: { supplier: 'Acme' } })
      .expect(201);
    expect(created.body.name).toBe('Pallet wrap 500mm');
    expect(created.body.attributes.supplier).toBe('Acme');
    const id = created.body.id as string;

    const list = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toContain(id);
    expect(list.body.categories).toContain('Packaging');

    // Adjust down below the min threshold → shows up in the low-stock count.
    // The reason must be kept in the adjustment ledger, not discarded.
    await request(app.getHttpServer()).post(`/v1/warehouse/stock/${id}/adjust`).set(auth).send({ delta: -35, reason: '35 damaged in transit' }).expect(201);
    const afterAdjust = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    const item = afterAdjust.body.items.find((s: { id: string }) => s.id === id);
    expect(item.quantity).toBe(5);
    expect(afterAdjust.body.lowStockCount).toBeGreaterThanOrEqual(1);

    // The adjustment ledger records the delta, resulting quantity, reason and actor.
    const adjustments = await request(app.getHttpServer()).get(`/v1/warehouse/stock/${id}/adjustments`).set(auth).expect(200);
    expect(adjustments.body.items).toHaveLength(1);
    expect(adjustments.body.items[0].delta).toBe(-35);
    expect(adjustments.body.items[0].quantityAfter).toBe(5);
    expect(adjustments.body.items[0].reason).toBe('35 damaged in transit');
    expect(adjustments.body.items[0].actorUser?.fullName).toBeTruthy();

    // Low-stock filter narrows to just the flagged items.
    const low = await request(app.getHttpServer()).get('/v1/warehouse/stock?lowStock=true').set(auth).expect(200);
    expect(low.body.items.map((s: { id: string }) => s.id)).toContain(id);

    // Bulk import — "move the entire stock over".
    const imported = await request(app.getHttpServer())
      .post('/v1/warehouse/stock/import')
      .set(auth)
      .send({ rows: [{ name: 'Box S', quantity: 100 }, { name: 'Box M', quantity: 60 }, { name: 'Box L' }] })
      .expect(201);
    expect(imported.body.created).toBe(3);
    expect(imported.body.failed).toBe(0);

    // Archive removes it from the default listing.
    await request(app.getHttpServer()).post(`/v1/warehouse/stock/${id}/archive`).set(auth).expect(201);
    const afterArchive = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    expect(afterArchive.body.items.map((s: { id: string }) => s.id)).not.toContain(id);
  });

  it('tracks machines and their maintenance/monitoring logs', async () => {
    const tenant = await createTestTenant(MANAGER);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const machine = await request(app.getHttpServer())
      .post('/v1/warehouse/machines')
      .set(auth)
      .send({ name: 'Forklift #2', machineType: 'Forklift', status: 'OPERATIONAL' })
      .expect(201);
    const machineId = machine.body.id as string;

    // A SERVICE log advances the machine's last-service marker.
    await request(app.getHttpServer())
      .post(`/v1/warehouse/machines/${machineId}/logs`)
      .set(auth)
      .send({ kind: 'SERVICE', summary: 'Annual service — hydraulics + brakes', meterValue: 1240, meterUnit: 'hrs' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/warehouse/machines/${machineId}/logs`)
      .set(auth)
      .send({ kind: 'READING', summary: 'Hour meter', meterValue: 1250, meterUnit: 'hrs' })
      .expect(201);

    const logs = await request(app.getHttpServer()).get(`/v1/warehouse/machines/${machineId}/logs`).set(auth).expect(200);
    expect(logs.body.items).toHaveLength(2);

    // Flip the machine DOWN → surfaces in the needs-attention count.
    await request(app.getHttpServer()).patch(`/v1/warehouse/machines/${machineId}`).set(auth).send({ status: 'DOWN' }).expect(200);
    const machines = await request(app.getHttpServer()).get('/v1/warehouse/machines').set(auth).expect(200);
    expect(machines.body.needsAttentionCount).toBeGreaterThanOrEqual(1);
    const listed = machines.body.items.find((m: { id: string }) => m.id === machineId);
    expect(listed.lastServiceAt).toBeTruthy();
    expect(listed._count.logs).toBe(2);
  });

  it('requires warehouse:manage to add stock (view alone is read-only)', async () => {
    const viewer = await createTestTenant([PERMISSIONS.WAREHOUSE_VIEW]);
    const token = await login(viewer.username);
    const res = await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'X' })
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.WAREHOUSE_MANAGE);
  });
});
