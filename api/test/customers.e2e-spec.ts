/**
 * Customers (fleet-internal address book): CRUD + archive lifecycle, and the
 * stop-creation integration — a stop referencing a saved Customer defaults its
 * label/address/contactName from it, with explicit fields still overriding.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [
  PERMISSIONS.CUSTOMERS_VIEW,
  PERMISSIONS.CUSTOMERS_CREATE,
  PERMISSIONS.CUSTOMERS_EDIT,
  PERMISSIONS.CUSTOMERS_ARCHIVE,
  PERMISSIONS.DISPATCH_VIEW,
  PERMISSIONS.DISPATCH_CREATE,
  PERMISSIONS.DISPATCH_EDIT,
  PERMISSIONS.DISPATCH_DELIVER,
  PERMISSIONS.ASSETS_CREATE,
];

describe('Customers (address book)', () => {
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

  it('searches server-side across the whole set, not just the current page', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    // Seed enough customers to span multiple pages.
    for (let i = 0; i < 8; i += 1) {
      await request(app.getHttpServer())
        .post('/v1/customers')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Bulk Customer ${i}`, contactName: `Person ${i}` })
        .expect(201);
    }
    // One needle that sorts last alphabetically (name asc), so it lands on a
    // later page — a client-side filter over page 1 would miss it.
    await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Zephyr Logistics', contactName: 'Ziggy' })
      .expect(201);

    // Page 1 with a tiny page size doesn't include the needle by name order…
    const page1 = await request(app.getHttpServer())
      .get('/v1/customers')
      .query({ pageSize: 3, page: 1 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(page1.body.total).toBe(9);
    expect((page1.body.items as { name: string }[]).some((c) => c.name === 'Zephyr Logistics')).toBe(false);

    // …but a server-side search finds it regardless of page.
    const searched = await request(app.getHttpServer())
      .get('/v1/customers')
      .query({ pageSize: 3, page: 1, search: 'zephyr' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(searched.body.total).toBe(1);
    expect((searched.body.items as { name: string }[])[0].name).toBe('Zephyr Logistics');

    // Search also matches a secondary field (contactName).
    const byContact = await request(app.getHttpServer())
      .get('/v1/customers')
      .query({ search: 'ziggy' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(byContact.body.total).toBe(1);
  });

  it('creates, edits, and archives a customer', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const created = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ACME Pty Ltd', address: '12 Smith St', contactName: 'Reception', phone: '0400 000 000' })
      .expect(201);
    expect(created.body.name).toBe('ACME Pty Ltd');

    const updated = await request(app.getHttpServer())
      .patch(`/v1/customers/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ address: '14 Smith St' })
      .expect(200);
    expect(updated.body.address).toBe('14 Smith St');

    await request(app.getHttpServer()).post(`/v1/customers/${created.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    const active = await request(app.getHttpServer()).get('/v1/customers').set('Authorization', `Bearer ${token}`).expect(200);
    expect(active.body.items.map((c: { id: string }) => c.id)).not.toContain(created.body.id);

    const withArchived = await request(app.getHttpServer()).get('/v1/customers?includeArchived=true').set('Authorization', `Bearer ${token}`).expect(200);
    expect(withArchived.body.items.map((c: { id: string }) => c.id)).toContain(created.body.id);
  });

  it('defaults a stop\'s label/address/contactName from a referenced customer, but lets explicit fields override', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const customer = await request(app.getHttpServer())
      .post('/v1/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'ACME Pty Ltd', address: '12 Smith St', contactName: 'Reception' })
      .expect(201);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        stops: [
          { customerId: customer.body.id }, // fully defaulted
          { customerId: customer.body.id, address: '99 Alternate Rd' }, // override address only
        ],
      })
      .expect(201);

    const full = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(full.body.stops[0].label).toBe('ACME Pty Ltd');
    expect(full.body.stops[0].address).toBe('12 Smith St');
    expect(full.body.stops[0].contactName).toBe('Reception');
    expect(full.body.stops[0].customer.id).toBe(customer.body.id);

    expect(full.body.stops[1].address).toBe('99 Alternate Rd');
    expect(full.body.stops[1].contactName).toBe('Reception');
  });

  it('rejects a stop with neither a label nor a customerId', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Run', assetId: asset.body.id }).expect(201);

    const res = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stops: [{ address: 'somewhere' }] })
      .expect(400);
    expect(res.body.error.code).toBe('STOP_LABEL_REQUIRED');
  });

  it('logs a customer\'s past deliveries from completed stops', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const auth = { Authorization: `Bearer ${token}` };
    const customer = await request(app.getHttpServer()).post('/v1/customers').set(auth).send({ name: 'Regular Co', address: '5 Depot Rd' }).expect(201);
    const asset = await request(app.getHttpServer()).post('/v1/assets').set(auth).send({ name: 'Van' }).expect(201);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set(auth).send({ title: 'Tuesday run', assetId: asset.body.id }).expect(201);

    await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/stops`)
      .set(auth)
      .send({ stops: [{ customerId: customer.body.id }, { customerId: customer.body.id }] })
      .expect(201);
    const full = await request(app.getHttpServer()).get(`/v1/jobs/${job.body.id}`).set(auth).expect(200);
    const [stop1, stop2] = full.body.stops as { id: string }[];

    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${stop1.id}/complete`).set(auth).send({ outcome: 'DELIVERED', recipientName: 'Sam' }).expect(201);
    await request(app.getHttpServer()).post(`/v1/jobs/${job.body.id}/stops/${stop2.id}/complete`).set(auth).send({ outcome: 'FAILED', failureReason: 'NOBODY_HOME' }).expect(201);

    const deliveries = await request(app.getHttpServer()).get(`/v1/customers/${customer.body.id}/deliveries`).set(auth).expect(200);
    expect(deliveries.body.summary).toEqual({ total: 2, delivered: 1, failed: 1, pending: 0 });
    const delivered = deliveries.body.items.find((d: { outcome: string }) => d.outcome === 'DELIVERED');
    expect(delivered.recipientName).toBe('Sam');
    expect(delivered.job.title).toBe('Tuesday run');
    const failed = deliveries.body.items.find((d: { outcome: string }) => d.outcome === 'FAILED');
    expect(failed.failureReason).toBe('NOBODY_HOME');
  });

  it('is tenant-isolated', async () => {
    const a = await createTestTenant(FULL);
    const b = await createTestTenant(FULL);
    const tokenA = await login(a.username);
    const tokenB = await login(b.username);
    const customerB = await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${tokenB}`).send({ name: 'B Co' }).expect(201);

    await request(app.getHttpServer()).get(`/v1/customers/${customerB.body.id}`).set('Authorization', `Bearer ${tokenA}`).expect(404);
  });

  it('requires customers:create', async () => {
    const viewOnly = await createTestTenant([PERMISSIONS.CUSTOMERS_VIEW]);
    const token = await login(viewOnly.username);
    const res = await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${token}`).send({ name: 'X' }).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.CUSTOMERS_CREATE);
  });
});
