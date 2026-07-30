/**
 * Fuel-card purchases: a driver records odometer, receipt photo, card last-4 and
 * licence plate from DriverOS; the office reads the log and spend.
 *
 * The card-data assertions are the important ones — only the last four digits may
 * ever be stored, so submitting anything longer must be refused rather than
 * silently persisted.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
// A 1x1 JPEG, so the attachment path's magic-byte sniffing is satisfied.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNCwsLDBkSEw8UHRofGh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDsyNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=';

const DRIVER = [PERMISSIONS.FUEL_LOG];
const OFFICE = [PERMISSIONS.FUEL_VIEW, PERMISSIONS.ASSETS_VIEW, PERMISSIONS.ASSETS_CREATE, PERMISSIONS.TIMELINE_VIEW];

describe('Fuel card entries', () => {
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

  it('records a purchase with odometer, receipt photo, card last-4 and plate', async () => {
    const t = await createTestTenant([...DRIVER, ...OFFICE]);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const asset = await request(app.getHttpServer())
      .post('/v1/assets').set(auth).send({ name: 'Truck 7', registration: 'ABC123' }).expect(201);

    const created = await request(app.getHttpServer())
      .post('/v1/fuel/entries')
      .set(auth)
      .send({
        assetId: asset.body.id,
        odometerReading: 184_320,
        licencePlate: 'abc123',
        cardLast4: '4321',
        litres: 92.5,
        totalCost: 178.4,
        receiptBase64: JPEG_BASE64,
        receiptFilename: 'receipt.jpg',
        receiptContentType: 'image/jpeg',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      odometerReading: 184_320,
      // Normalised so 'abc123' and 'ABC123' reconcile against the same statement.
      licencePlate: 'ABC123',
      cardLast4: '4321',
    });
    expect(created.body.receiptAttachment).toMatchObject({ contentType: 'image/jpeg' });
    // Metadata only — the photo bytes are never inlined into the fuel row.
    expect(created.body.receiptAttachment.dataBase64).toBeUndefined();

    const list = await request(app.getHttpServer()).get('/v1/fuel/entries').set(auth).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].asset).toMatchObject({ name: 'Truck 7' });

    const summary = await request(app.getHttpServer()).get('/v1/fuel/summary').set(auth).expect(200);
    expect(summary.body.entryCount).toBe(1);
    expect(Number(summary.body.totalCost)).toBeCloseTo(178.4, 2);
    expect(Number(summary.body.totalLitres)).toBeCloseTo(92.5, 2);
  });

  it('refuses anything other than exactly 4 card digits — a full PAN must never be stored', async () => {
    const t = await createTestTenant(DRIVER);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const base = { odometerReading: 1000, licencePlate: 'XYZ789' };
    // A full card number, a 3-digit slip, and a non-numeric value are all refused.
    for (const cardLast4 of ['4111111111111111', '432', '43a1', '']) {
      await request(app.getHttpServer())
        .post('/v1/fuel/entries')
        .set(auth)
        .send({ ...base, cardLast4 })
        .expect(400);
    }

    // Nothing was persisted by any of those attempts.
    const count = await ownerPrisma.fuelEntry.count({ where: { companyId: t.companyId } });
    expect(count).toBe(0);
  });

  it('puts the refuel on the asset timeline so a vehicle shows its own fuel history', async () => {
    const t = await createTestTenant([...DRIVER, ...OFFICE]);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };
    const asset = await request(app.getHttpServer())
      .post('/v1/assets').set(auth).send({ name: 'Truck 9' }).expect(201);

    await request(app.getHttpServer())
      .post('/v1/fuel/entries')
      .set(auth)
      .send({ assetId: asset.body.id, odometerReading: 5000, licencePlate: 'JJJ111', cardLast4: '9876', totalCost: 120 })
      .expect(201);

    const timeline = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'ASSET', entityId: asset.body.id })
      .set(auth)
      .expect(200);

    const event = timeline.body.items.find((e: { eventType: string }) => e.eventType === 'fuel_recorded');
    expect(event).toBeDefined();
    expect(event.payload).toMatchObject({ odometerReading: 5000, cardLast4: '9876' });
  });

  it('keeps fuel entries tenant-isolated and gates reads behind fuel:view', async () => {
    const a = await createTestTenant([...DRIVER, ...OFFICE]);
    const b = await createTestTenant([...DRIVER, ...OFFICE]);
    const authA = { Authorization: `Bearer ${await login(a.username)}` };
    const authB = { Authorization: `Bearer ${await login(b.username)}` };

    await request(app.getHttpServer())
      .post('/v1/fuel/entries').set(authA)
      .send({ odometerReading: 42, licencePlate: 'AAA111', cardLast4: '1111' }).expect(201);

    const bList = await request(app.getHttpServer()).get('/v1/fuel/entries').set(authB).expect(200);
    expect(bList.body.items.some((i: { licencePlate: string }) => i.licencePlate === 'AAA111')).toBe(false);

    // A driver who can log fuel but not view it is refused the office read.
    const driverOnly = await createTestTenant(DRIVER);
    const driverAuth = { Authorization: `Bearer ${await login(driverOnly.username)}` };
    await request(app.getHttpServer()).get('/v1/fuel/entries').set(driverAuth).expect(403);
  });
});
