/**
 * Configurable barcode scanning (01-Product/Barcode_Scanning.md): per-company
 * searchable fields + field mappings + scan mode, and the core /scan endpoint
 * that matches an existing StopParcel across the whole company (not just the
 * current run) and populates configured fields via direct copy or database
 * lookup. Admin-config routes are gated on barcode_config:manage; the scan
 * itself is gated on dispatch:edit, matching parcels.e2e-spec.ts.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_CANCEL,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.BARCODE_CONFIG_MANAGE,
  PERMISSIONS.CUSTOMERS_CREATE,
  PERMISSIONS.CUSTOMERS_VIEW,
];

describe('Barcode scanning', () => {
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

  async function makeJobAndStop(token: string, customerId?: string): Promise<{ jobId: string; stopId: string }> {
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Barcode run' }).expect(201);
    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ label: 'Drop', customerId }] })
      .expect(201);
    const withStops = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    return { jobId: job.body.id, stopId: withStops.body.stops[0].id };
  }

  it('auto-creates a default config + 6 built-in searchable fields on first read', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };

    const res = await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);
    expect(res.body.scanConfig.scanMode).toBe('DATABASE_LOOKUP');
    expect(res.body.scanConfig.allowManualEntry).toBe(true);
    expect(res.body.scanConfig.blockOnMissingFields).toBe(false);
    expect(res.body.scanConfig.requiredFields).toEqual([]);
    expect(res.body.searchableFields).toHaveLength(6);
    expect(res.body.searchableFields.map((f: { key: string }) => f.key).sort()).toEqual(
      ['consignmentNumber', 'customerReference', 'internalId', 'manifestNumber', 'reference', 'trackingNumber'].sort(),
    );
    expect(res.body.fieldMappings).toEqual([]);

    // A second read doesn't duplicate the seeded rows.
    const again = await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);
    expect(again.body.searchableFields).toHaveLength(6);
    expect(again.body.scanConfig.id).toBe(res.body.scanConfig.id);
  });

  it('creates a custom searchable field and a field mapping', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);

    const field = await request(app.getHttpServer())
      .post('/v1/barcode/searchable-fields')
      .set(auth)
      .send({ key: 'poNumber', label: 'PO Number', isCustom: true })
      .expect(201);
    expect(field.body.isCustom).toBe(true);

    // Rejecting a non-custom key that isn't a real StopParcel column.
    await request(app.getHttpServer())
      .post('/v1/barcode/searchable-fields')
      .set(auth)
      .send({ key: 'notARealColumn', label: 'Bad' })
      .expect(400);

    const mapping = await request(app.getHttpServer())
      .post('/v1/barcode/field-mappings')
      .set(auth)
      .send({ sourceField: 'scan', targetField: 'TRACKING_NUMBER', isDatabaseLookup: false, order: 0 })
      .expect(201);
    expect(mapping.body.sourceField).toBe('scan');

    const updated = await request(app.getHttpServer())
      .patch(`/v1/barcode/searchable-fields/${field.body.id}`)
      .set(auth)
      .send({ label: 'Purchase Order Number' })
      .expect(200);
    expect(updated.body.label).toBe('Purchase Order Number');

    await request(app.getHttpServer()).post(`/v1/barcode/searchable-fields/${field.body.id}/archive`).set(auth).expect(201);
    const afterArchive = await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);
    expect(afterArchive.body.searchableFields.map((f: { id: string }) => f.id)).not.toContain(field.body.id);
  });

  it('DATABASE_LOOKUP scan matches an existing parcel from a different run and populates a mapped field via lookup', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);

    const customer = await request(app.getHttpServer())
      .post('/v1/customers')
      .set(auth)
      .send({ name: 'Acme Co' })
      .expect(201);

    // A mapping so scanning by trackingNumber pulls the CUSTOMER off the
    // already-matched parcel's stop.
    await request(app.getHttpServer())
      .post('/v1/barcode/field-mappings')
      .set(auth)
      .send({ sourceField: 'trackingNumber', targetField: 'CUSTOMER', isDatabaseLookup: true, order: 0 })
      .expect(201);

    const first = await makeJobAndStop(token, customer.body.id);
    // Seed a parcel with a trackingNumber via the UNKNOWN -> create flow (the
    // only path that can set fields beyond bare reference/label).
    const unknownScan = await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set(auth)
      .send({ jobId: first.jobId, stopId: first.stopId, scannedValue: 'TRK-999' })
      .expect(201);
    expect(unknownScan.body.outcome).toBe('UNKNOWN');

    await request(app.getHttpServer())
      .post(`/v1/barcode/scan/${unknownScan.body.scanEventId}/create`)
      .set(auth)
      .send({ jobId: first.jobId, stopId: first.stopId, fields: { reference: 'REF-1', trackingNumber: 'TRK-999' } })
      .expect(201);

    // A SECOND, unrelated run scans the same trackingNumber — matched
    // company-wide, not just on the original stop.
    const second = await makeJobAndStop(token);
    const matched = await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set(auth)
      .send({ jobId: second.jobId, stopId: second.stopId, scannedValue: 'TRK-999' })
      .expect(201);
    expect(matched.body.outcome).toBe('MATCHED');
    expect(matched.body.matchedParcel.reference).toBe('REF-1');
    expect(matched.body.populatedFields.customer.name).toBe('Acme Co');
  });

  it('returns UNKNOWN for a scan with no match', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);
    const { jobId, stopId } = await makeJobAndStop(token);

    const res = await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set(auth)
      .send({ jobId, stopId, scannedValue: 'NOPE-1' })
      .expect(201);
    expect(res.body.outcome).toBe('UNKNOWN');
    expect(res.body.matchedParcel).toBeUndefined();
  });

  it('blocks a duplicate when the matched parcel belongs to a CANCELLED job', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    await request(app.getHttpServer()).get('/v1/barcode/config').set(auth).expect(200);

    const { jobId, stopId } = await makeJobAndStop(token);
    const unknownScan = await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set(auth)
      .send({ jobId, stopId, scannedValue: 'REF-CANCEL-1' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/barcode/scan/${unknownScan.body.scanEventId}/create`)
      .set(auth)
      .send({ jobId, stopId, fields: { reference: 'REF-CANCEL-1' } })
      .expect(201);

    await request(app.getHttpServer()).post(`/v1/jobs/${jobId}/cancel`).set(auth).expect(201);

    const other = await makeJobAndStop(token);
    const blocked = await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set(auth)
      .send({ jobId: other.jobId, stopId: other.stopId, scannedValue: 'REF-CANCEL-1' })
      .expect(201);
    expect(blocked.body.outcome).toBe('DUPLICATE_BLOCKED');
    expect(blocked.body.matchedParcel.reference).toBe('REF-CANCEL-1');
  });

  it('isolates barcode config and scan history between tenants', async () => {
    const tenantA = await createTestTenant(FULL);
    const tokenA = await login(tenantA.username);
    const authA = { Authorization: `Bearer ${tokenA}` };
    const tenantB = await createTestTenant(FULL);
    const tokenB = await login(tenantB.username);
    const authB = { Authorization: `Bearer ${tokenB}` };

    await request(app.getHttpServer()).get('/v1/barcode/config').set(authA).expect(200);
    await request(app.getHttpServer())
      .post('/v1/barcode/searchable-fields')
      .set(authA)
      .send({ key: 'aOnly', label: 'A Only', isCustom: true })
      .expect(201);

    const bConfig = await request(app.getHttpServer()).get('/v1/barcode/config').set(authB).expect(200);
    expect(bConfig.body.searchableFields.map((f: { key: string }) => f.key)).not.toContain('aOnly');

    const { jobId, stopId } = await makeJobAndStop(tokenA);
    await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set(authA)
      .send({ jobId, stopId, scannedValue: 'ISOLATION-CHECK' })
      .expect(201);

    const historyA = await request(app.getHttpServer()).get('/v1/barcode/scan-history').set(authA).expect(200);
    expect(historyA.body.items.some((e: { scannedValue: string }) => e.scannedValue === 'ISOLATION-CHECK')).toBe(true);

    const historyB = await request(app.getHttpServer()).get('/v1/barcode/scan-history').set(authB).expect(200);
    expect(historyB.body.items.some((e: { scannedValue: string }) => e.scannedValue === 'ISOLATION-CHECK')).toBe(false);
  });

  it('requires barcode_config:manage for config routes and dispatch:edit for scanning', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const { jobId, stopId } = await makeJobAndStop(token);

    const noConfigPerm = await createTestTenant([PERMISSIONS.DISPATCH_VIEW, PERMISSIONS.DISPATCH_EDIT]);
    const noConfigToken = await login(noConfigPerm.username);
    const resConfig = await request(app.getHttpServer())
      .get('/v1/barcode/config')
      .set('Authorization', `Bearer ${noConfigToken}`)
      .expect(403);
    expect(resConfig.body.error.requiredPermission).toBe(PERMISSIONS.BARCODE_CONFIG_MANAGE);

    const noEditPerm = await createTestTenant([PERMISSIONS.DISPATCH_VIEW, PERMISSIONS.BARCODE_CONFIG_MANAGE]);
    const noEditToken = await login(noEditPerm.username);
    const resScan = await request(app.getHttpServer())
      .post('/v1/barcode/scan')
      .set('Authorization', `Bearer ${noEditToken}`)
      .send({ jobId, stopId, scannedValue: 'X' })
      .expect(403);
    expect(resScan.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_EDIT);
  });
});
