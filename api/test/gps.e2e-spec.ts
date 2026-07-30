/**
 * Universal GPS ingest: register a hardware tracker (get a device key), bind it
 * to an asset, POST a position with just that key (no user login), and see the
 * asset's position on the fleet map. Covers the key auth, the unknown-key
 * rejection, tenant isolation of devices, and the management permission gate.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const MANAGE = [PERMISSIONS.GPS_DEVICE_MANAGE, PERMISSIONS.LOCATION_VIEW, PERMISSIONS.ASSETS_CREATE, PERMISSIONS.ASSETS_VIEW];

describe('Universal GPS ingest', () => {
  let app: INestApplication;
  // Connects as the low-privilege, RLS-subject runtime role (fleetos_app) — the
  // same role the app uses — to prove the GPS RLS policy blocks cross-tenant
  // reads at the database, independent of the service-layer companyId filter.
  const appPrisma = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });

  /** Run a query with the tenant GUC set, exactly like PrismaService.withTenant. */
  async function asTenant<T>(companyId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return appPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return fn(tx as unknown as PrismaClient);
    });
  }

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await appPrisma.$disconnect();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<Record<string, string>> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  it('registers a tracker, ingests a position by key, and shows the asset on the map', async () => {
    const tenant = await createTestTenant(MANAGE);
    const auth = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Truck 7' }).expect(201);

    const device = await request(app.getHttpServer()).post('/v1/gps/devices').set(auth).send({ name: 'Teltonika 1', assetId: asset.body.id }).expect(201);
    expect(device.body.deviceKey).toMatch(/^gps_/);

    // Ingest with ONLY the device key — no Authorization header.
    await request(app.getHttpServer()).post('/v1/gps/ingest').send({ deviceKey: device.body.deviceKey, lat: -37.81, lng: 144.96 }).expect(201);

    const positions = await request(app.getHttpServer()).get('/v1/gps/positions').set(auth).expect(200);
    const mine = positions.body.items.find((p: { asset: { id: string } | null }) => p.asset?.id === asset.body.id);
    expect(mine).toBeDefined();
    expect(mine.lat).toBeCloseTo(-37.81);
    expect(mine.asset.name).toBe('Truck 7');

    // The list never leaks the secret key.
    const list = await request(app.getHttpServer()).get('/v1/gps/devices').set(auth).expect(200);
    expect(list.body.items[0]).not.toHaveProperty('deviceKey');
  });

  it('rejects an unknown device key', async () => {
    const res = await request(app.getHttpServer()).post('/v1/gps/ingest').send({ deviceKey: 'gps_not_a_real_key_000000', lat: 0, lng: 0 }).expect(404);
    expect(res.body.error.code).toBe('GPS_DEVICE_UNKNOWN');
  });

  it('keeps GPS device/position data tenant-isolated — enforced by row-level security', async () => {
    // gps_devices/gps_pings are now RLS-protected (tenant_isolation policy). The
    // ingest path authenticates by device key with no company context, so it
    // runs through the BYPASSRLS role; every user-facing read goes through the
    // RLS-enforced tenant role. This asserts isolation both through the API and
    // directly at the database as the RLS-subject app role.
    const a = await createTestTenant(MANAGE);
    const b = await createTestTenant(MANAGE);
    const authA = await login(a.username);
    const authB = await login(b.username);

    const assetA = await request(app.getHttpServer()).post('/v1/assets').set(authA).send({ name: 'A Truck' }).expect(201);
    const deviceA = await request(app.getHttpServer()).post('/v1/gps/devices').set(authA).send({ name: 'A tracker', assetId: assetA.body.id }).expect(201);
    await request(app.getHttpServer()).post('/v1/gps/ingest').send({ deviceKey: deviceA.body.deviceKey, lat: -37.81, lng: 144.96 }).expect(201);

    // Tenant B's map must never include tenant A's device or asset position.
    const positionsB = await request(app.getHttpServer()).get('/v1/gps/positions').set(authB).expect(200);
    expect(positionsB.body.items.some((p: { deviceId: string }) => p.deviceId === deviceA.body.id)).toBe(false);
    expect(positionsB.body.items.some((p: { asset: { id: string } | null }) => p.asset?.id === assetA.body.id)).toBe(false);

    // And tenant A still sees its own.
    const positionsA = await request(app.getHttpServer()).get('/v1/gps/positions').set(authA).expect(200);
    expect(positionsA.body.items.some((p: { deviceId: string }) => p.deviceId === deviceA.body.id)).toBe(true);

    // Database-level proof: as the RLS-subject app role, tenant B's GUC cannot
    // see tenant A's device or its pings at all — a forgotten service-layer
    // filter would still be caught by the policy.
    const seenByB = await asTenant(b.companyId, (tx) => tx.gpsDevice.findUnique({ where: { id: deviceA.body.id } }));
    expect(seenByB).toBeNull();
    const pingsByB = await asTenant(b.companyId, (tx) => tx.gpsPing.count({ where: { deviceId: deviceA.body.id } }));
    expect(pingsByB).toBe(0);
    // Tenant A's own GUC sees them.
    const seenByA = await asTenant(a.companyId, (tx) => tx.gpsDevice.findUnique({ where: { id: deviceA.body.id } }));
    expect(seenByA).not.toBeNull();
    const pingsByA = await asTenant(a.companyId, (tx) => tx.gpsPing.count({ where: { deviceId: deviceA.body.id } }));
    expect(pingsByA).toBeGreaterThan(0);
  });

  it('keeps devices tenant-isolated and gates management', async () => {
    const a = await createTestTenant(MANAGE);
    const b = await createTestTenant(MANAGE);
    const authA = await login(a.username);
    const authB = await login(b.username);
    const deviceA = await request(app.getHttpServer()).post('/v1/gps/devices').set(authA).send({ name: 'A device' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/gps/devices/${deviceA.body.id}/archive`).set(authB).expect(404);

    const viewer = await createTestTenant([PERMISSIONS.LOCATION_VIEW]);
    const authV = await login(viewer.username);
    const denied = await request(app.getHttpServer()).post('/v1/gps/devices').set(authV).send({ name: 'X' }).expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.GPS_DEVICE_MANAGE);
  });
});
