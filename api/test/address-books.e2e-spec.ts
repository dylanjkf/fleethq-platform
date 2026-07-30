/**
 * Depot/customer address books (Saved Layout): save a company's depots and
 * customers into a named, portable book, then export the payload and import it
 * into a second company — the multi-entity operator flow. Covers save+counts,
 * export→import→apply into another company (idempotent), and the permission gate.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensurePermissions } from './utils/fixtures';

const MANAGE = [
  PERMISSIONS.ADDRESS_BOOK_MANAGE,
  PERMISSIONS.DEPOTS_VIEW,
  PERMISSIONS.DEPOTS_CREATE,
  PERMISSIONS.CUSTOMERS_VIEW,
  PERMISSIONS.CUSTOMERS_CREATE,
];

describe('Address books', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
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
  const makeDepot = (auth: Record<string, string>, name: string) =>
    request(app.getHttpServer()).post('/v1/depots').set(auth).send({ name, address: `${name} St` }).expect(201);
  const makeCustomer = (auth: Record<string, string>, name: string) =>
    request(app.getHttpServer()).post('/v1/customers').set(auth).send({ name, phone: '000', contactName: 'Pat' }).expect(201);

  it('saves depots+customers, then exports and imports the book into another company (idempotently)', async () => {
    const a = await createTestTenant(MANAGE);
    const authA = await login(a.username);
    await makeDepot(authA, 'Main Depot');
    await makeDepot(authA, 'North Branch');
    await makeCustomer(authA, 'Acme Co');

    // Save the current locations into a book.
    const book = await request(app.getHttpServer()).post('/v1/address-books').set(authA).send({ name: 'City network' }).expect(201);
    expect(book.body.depotCount).toBe(2);
    expect(book.body.customerCount).toBe(1);

    // Export the portable payload.
    const exported = await request(app.getHttpServer()).get(`/v1/address-books/${book.body.id}/export`).set(authA).expect(200);
    expect(exported.body.entries).toHaveLength(3);

    // Second company imports the payload as its own book, then applies it.
    const b = await createTestTenant(MANAGE);
    const authB = await login(b.username);
    const importedBook = await request(app.getHttpServer()).post('/v1/address-books/import').set(authB).send(exported.body).expect(201);
    expect(importedBook.body.depotCount).toBe(2);

    const applied = await request(app.getHttpServer()).post(`/v1/address-books/${importedBook.body.id}/apply`).set(authB).expect(201);
    expect(applied.body).toEqual({ depotsCreated: 2, customersCreated: 1, skipped: 0 });

    // Company B now has the depots/customers; re-applying skips them all.
    const depotsB = await request(app.getHttpServer()).get('/v1/depots').set(authB).expect(200);
    expect(depotsB.body.items.map((d: { name: string }) => d.name).sort()).toEqual(['Main Depot', 'North Branch']);
    const reapplied = await request(app.getHttpServer()).post(`/v1/address-books/${importedBook.body.id}/apply`).set(authB).expect(201);
    expect(reapplied.body).toEqual({ depotsCreated: 0, customersCreated: 0, skipped: 3 });
  });

  it('requires address_book:manage', async () => {
    const viewer = await createTestTenant([PERMISSIONS.DEPOTS_VIEW]);
    const auth = await login(viewer.username);
    const res = await request(app.getHttpServer()).post('/v1/address-books').set(auth).send({ name: 'X' }).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.ADDRESS_BOOK_MANAGE);
  });
});
