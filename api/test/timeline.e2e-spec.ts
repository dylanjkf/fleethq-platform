/**
 * Entity Timeline read endpoint: every mutation across the platform already
 * writes a TimelineEvent (TimelineService.record) — this is the first read
 * endpoint over that history, backing FleetHQ's Entity Timeline viewer.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [PERMISSIONS.TIMELINE_VIEW, PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.CUSTOMERS_EDIT, PERMISSIONS.CUSTOMERS_ARCHIVE];

describe('Timeline (read)', () => {
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

  it('returns an entity’s events newest-first', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const customer = await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${token}`).send({ name: 'ACME' }).expect(201);
    await request(app.getHttpServer()).patch(`/v1/customers/${customer.body.id}`).set('Authorization', `Bearer ${token}`).send({ name: 'ACME Pty Ltd' }).expect(200);
    await request(app.getHttpServer()).post(`/v1/customers/${customer.body.id}/archive`).set('Authorization', `Bearer ${token}`).expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'CUSTOMER', entityId: customer.body.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    const eventTypes = res.body.items.map((e: { eventType: string }) => e.eventType);
    expect(eventTypes[0]).toBe('archived');
    expect(new Date(res.body.items[0].occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(res.body.items[res.body.items.length - 1].occurredAt).getTime());
  });

  it('returns a company-wide recent feed across entities', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);

    const c1 = await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${token}`).send({ name: 'First Co' }).expect(201);
    const c2 = await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${token}`).send({ name: 'Second Co' }).expect(201);

    const res = await request(app.getHttpServer())
      .get('/v1/timeline/recent')
      .query({ limit: 5 })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    // Newest first — the most recent creation heads the feed, and both entities appear.
    const ids = res.body.items.map((e: { entityId: string }) => e.entityId);
    expect(ids).toContain(c1.body.id);
    expect(ids).toContain(c2.body.id);
    expect(new Date(res.body.items[0].occurredAt).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body.items[res.body.items.length - 1].occurredAt).getTime(),
    );
  });

  it('recent feed requires timeline:view', async () => {
    const noPerm = await createTestTenant([]);
    const token = await login(noPerm.username);
    await request(app.getHttpServer()).get('/v1/timeline/recent').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('is tenant-isolated and requires timeline:view', async () => {
    const a = await createTestTenant(FULL);
    const tokenA = await login(a.username);
    const customer = await request(app.getHttpServer()).post('/v1/customers').set('Authorization', `Bearer ${tokenA}`).send({ name: 'A Co' }).expect(201);

    const b = await createTestTenant(FULL);
    const tokenB = await login(b.username);
    const crossTenant = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'CUSTOMER', entityId: customer.body.id })
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(crossTenant.body.total).toBe(0);

    const noPerm = await createTestTenant([]);
    const tokenNoPerm = await login(noPerm.username);
    const res = await request(app.getHttpServer())
      .get('/v1/timeline')
      .query({ entityType: 'CUSTOMER', entityId: customer.body.id })
      .set('Authorization', `Bearer ${tokenNoPerm}`)
      .expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.TIMELINE_VIEW);
  });
});
