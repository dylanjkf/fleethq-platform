/**
 * Data retention: GPS breadcrumbs older than the retention floor are purged,
 * recent ones are kept, and the purge is tenant-scoped. Location history is
 * personal information, so this enforces the data-retention policy (ISO A.8.10).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { RetentionService } from '../src/retention/retention.service';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const DAY = 24 * 60 * 60 * 1000;

describe('GPS breadcrumb retention', () => {
  let app: INestApplication;
  let retention: RetentionService;
  // Owner role (DATABASE_URL) to seed breadcrumbs with a back-dated recordedAt,
  // which the ingest API (always "now") cannot produce.
  const owner = new PrismaClient();

  beforeAll(async () => {
    app = await buildTestApp();
    retention = app.get(RetentionService);
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
    await disconnectFixtures();
  });

  async function seedDeviceWithPings(companyId: string, recordedAts: Date[]): Promise<string> {
    const device = await owner.gpsDevice.create({
      data: { companyId, name: `Tracker ${randomUUID().slice(0, 8)}`, deviceKeyHash: createHash('sha256').update(randomUUID()).digest('hex') },
    });
    await owner.gpsPing.createMany({
      data: recordedAts.map((recordedAt) => ({ companyId, deviceId: device.id, lat: -37.8, lng: 144.9, recordedAt })),
    });
    return device.id;
  }

  it('purges breadcrumbs older than the retention floor and keeps recent ones', async () => {
    const tenant = await createTestTenant([]);
    const now = new Date();
    const deviceId = await seedDeviceWithPings(tenant.companyId, [
      new Date(now.getTime() - 600 * DAY), // older than the 540-day default → purge
      new Date(now.getTime() - 700 * DAY), // older → purge
      new Date(now.getTime() - 10 * DAY), // recent → keep
    ]);

    const deleted = await retention.purgeCompanyGpsPings(tenant.companyId, now);
    expect(deleted).toBe(2);

    const remaining = await owner.gpsPing.findMany({ where: { deviceId } });
    expect(remaining).toHaveLength(1);
    expect(now.getTime() - remaining[0].recordedAt.getTime()).toBeLessThan(540 * DAY);
  });

  it('only purges the target tenant (cross-tenant safe)', async () => {
    const a = await createTestTenant([]);
    const b = await createTestTenant([]);
    const now = new Date();
    const oldOnly = [new Date(now.getTime() - 600 * DAY)];
    const deviceA = await seedDeviceWithPings(a.companyId, oldOnly);
    const deviceB = await seedDeviceWithPings(b.companyId, oldOnly);

    await retention.purgeCompanyGpsPings(a.companyId, now);

    // B's old breadcrumb is untouched — the purge was scoped to A.
    expect(await owner.gpsPing.count({ where: { deviceId: deviceA } })).toBe(0);
    expect(await owner.gpsPing.count({ where: { deviceId: deviceB } })).toBe(1);
  });
});
