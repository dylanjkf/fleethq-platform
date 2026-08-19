/**
 * Warehouse is hidden behind the admin-managed `warehouse` feature flag
 * (`@RequireFeatureFlag('warehouse')` on the controller) — a separate axis from
 * the billing paywall. `prod-bootstrap` seeds this flag `globalEnabled:false`,
 * so in production every warehouse route returns a clean 403 `FEATURE_DISABLED`
 * (NOT a 500) until an admin turns it on, globally or per-company, from the
 * console. No warehouse data is touched by the flag.
 *
 * This suite proves the guard's behaviour without disturbing the other warehouse
 * suites (which rely on the flag being absent → fail-open): it keeps the global
 * flag ON and drives the disabled state through a per-company override, which is
 * tenant-scoped and can't leak across suites. The default-off value that hides
 * the module in production is asserted separately in the unit test
 * `src/bootstrap/bootstrap-feature-flags.spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const MANAGER = [PERMISSIONS.WAREHOUSE_VIEW, PERMISSIONS.WAREHOUSE_MANAGE];

describe('Warehouse feature flag (admin rollout gate)', () => {
  let app: INestApplication;
  let flagId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
    // Keep the GLOBAL flag ON so concurrent warehouse suites (which add no
    // override) still evaluate to enabled — the disabled state here is driven
    // purely by a per-company override, which is tenant-scoped.
    const flag = await ownerPrisma.featureFlag.upsert({
      where: { key: 'warehouse' },
      update: { globalEnabled: true },
      create: { key: 'warehouse', name: 'Warehouse', description: 'test', globalEnabled: true },
    });
    flagId = flag.id;
  });

  afterAll(async () => {
    // Remove the flag entirely so other suites resume the fail-open default.
    await ownerPrisma.featureFlagOverride.deleteMany({ where: { flagId } });
    await ownerPrisma.featureFlag.deleteMany({ where: { key: 'warehouse' } });
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('returns a clean 403 FEATURE_DISABLED (not a 500) for a company the flag is turned off for', async () => {
    const tenant = await createTestTenant(MANAGER);
    await ownerPrisma.featureFlagOverride.create({ data: { flagId, companyId: tenant.companyId, enabled: false } });
    const auth = { Authorization: `Bearer ${await login(tenant.username)}` };

    const read = await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(403);
    // HttpExceptionFilter normalises every error into a single `{ error: … }` envelope.
    expect(read.body.error).toMatchObject({ code: 'FEATURE_DISABLED', feature: 'warehouse' });

    // The write path is gated by the same controller-level flag.
    await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set(auth)
      .send({ sku: 'FLAG-OFF-1', name: 'Blocked item', quantity: 1 })
      .expect(403);
  });

  it('lets the same company back in the moment the flag is turned on for it — no data lost', async () => {
    const tenant = await createTestTenant(MANAGER);
    // Turn the module off for this company and create nothing…
    const override = await ownerPrisma.featureFlagOverride.create({ data: { flagId, companyId: tenant.companyId, enabled: false } });
    const auth = { Authorization: `Bearer ${await login(tenant.username)}` };
    await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(403);

    // …flip the override on (what an admin would do) → access is restored.
    await ownerPrisma.featureFlagOverride.update({ where: { id: override.id }, data: { enabled: true } });
    await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
    await request(app.getHttpServer())
      .post('/v1/warehouse/stock')
      .set(auth)
      .send({ sku: 'FLAG-ON-1', name: 'Allowed item', quantity: 2 })
      .expect(201);
  });

  it('is enabled by the global flag when a company has no override', async () => {
    const tenant = await createTestTenant(MANAGER);
    const auth = { Authorization: `Bearer ${await login(tenant.username)}` };
    // Global flag is ON in this suite and this company has no override → allowed.
    await request(app.getHttpServer()).get('/v1/warehouse/stock').set(auth).expect(200);
  });
});
