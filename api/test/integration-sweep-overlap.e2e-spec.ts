/**
 * Integration sweep overlap (audit Part 4). The scheduler fires
 * runDueScheduledSyncsForCompany / retryDueDeadLettersForCompany per company on
 * a lease. If one run outlasts the lease, the next tick starts while the first
 * is still going, so two sweeps run concurrently and each re-selects the SAME
 * due row (a due connection, a due dead letter) — then both import it. Because
 * Asset/Operator/AttachedUnit/ComplianceDocument imports have no natural-key
 * dedup, that produces DUPLICATE records, not idempotent no-ops.
 *
 * The fix claims each row atomically before running it — the scheduled sweep
 * with a compare-and-swap on nextRunAt, the dead-letter sweep with a
 * PENDING_RETRY → RETRYING transition — so the loser of the race matches 0 rows
 * and skips. These tests fire the two sweeps with Promise.all and assert exactly
 * one run / one imported record. Reverting either claim makes the count 2.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { IntegrationSyncEngine } from '../src/integrations/integration-sync-engine.service';

describe('Integration sweep overlap (Part 4)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient();
  let engine: IntegrationSyncEngine;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
    engine = app.get(IntegrationSyncEngine);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await disconnectFixtures();
  });

  it('scheduled sweep: two overlapping runs fire a due connection exactly once', async () => {
    const tenant = await createTestTenant([]);
    // A due CSV connection with a cron so nextRunAt would advance on a real run.
    const connection = await prisma.integrationConnection.create({
      data: {
        companyId: tenant.companyId,
        name: 'Due CSV',
        connectorType: 'CSV',
        direction: 'IMPORT',
        targetEntity: 'customers',
        config: {},
        isEnabled: true,
        scheduleCron: '*/5 * * * *',
        nextRunAt: new Date(Date.now() - 60_000), // due one minute ago
      },
    });

    // Two sweeps race, exactly as an over-running lease would overlap them.
    const [a, b] = await Promise.all([
      engine.runDueScheduledSyncsForCompany(tenant.companyId),
      engine.runDueScheduledSyncsForCompany(tenant.companyId),
    ]);

    // Exactly one sweep claimed and ran the connection; the other skipped it.
    expect(a.ran + b.ran).toBe(1);

    // Only ONE sync run row was created for this connection (runSync creates one
    // per execution) — the proof that runSync fired once, not twice.
    const runs = await prisma.integrationSyncRun.findMany({ where: { connectionId: connection.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe('SCHEDULED');

    // nextRunAt was advanced out of the due window by the claim.
    const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('dead-letter sweep: two overlapping runs retry a due row exactly once (no duplicate import)', async () => {
    const tenant = await createTestTenant([]);
    // An assets connection — assets have NO natural-key dedup, so a double retry
    // would create two Asset rows (the real harm this claim prevents).
    const connection = await prisma.integrationConnection.create({
      data: {
        companyId: tenant.companyId,
        name: 'Assets REST',
        connectorType: 'REST',
        direction: 'IMPORT',
        targetEntity: 'assets',
        config: { url: 'https://example.test/assets' },
        isEnabled: true,
      },
    });
    // Map the raw payload's AssetName → the asset's required `name`.
    await prisma.integrationFieldMapping.create({
      data: { companyId: tenant.companyId, connectionId: connection.id, externalField: 'AssetName', fleetField: 'name', transform: 'TRIM', isRequired: true, order: 0 },
    });

    const assetName = `Sweep Truck ${Date.now()}`;
    await prisma.integrationDeadLetter.create({
      data: {
        companyId: tenant.companyId,
        connectionId: connection.id,
        rawPayload: { AssetName: assetName },
        errorMessage: 'seeded for overlap test',
        attempts: 1,
        status: 'PENDING_RETRY',
        nextRetryAt: new Date(Date.now() - 60_000), // due one minute ago
      },
    });

    // Two dead-letter sweeps race.
    const [a, b] = await Promise.all([
      engine.retryDueDeadLettersForCompany(tenant.companyId),
      engine.retryDueDeadLettersForCompany(tenant.companyId),
    ]);

    // Exactly one sweep retried the row; the other's claim matched 0 rows.
    expect(a.resolved + b.resolved).toBe(1);
    expect(a.retried + b.retried).toBe(1);

    // The row was imported ONCE — a single Asset exists, not two.
    const assets = await prisma.asset.findMany({ where: { companyId: tenant.companyId, name: assetName } });
    expect(assets).toHaveLength(1);

    // The dead letter resolved (moved out of RETRYING, not stuck).
    const dl = await prisma.integrationDeadLetter.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(dl.status).toBe('RESOLVED');
  });
});
