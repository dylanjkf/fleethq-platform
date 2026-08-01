/**
 * Operator shift start/end + day summary: a plain clock-in/clock-out. Only a
 * linked Operator login can start/end their own shift; the office views the
 * day summary rolled up per operator.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createOperatorLinkedToUser, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const OFFICE = [PERMISSIONS.SHIFTS_VIEW, PERMISSIONS.OPERATORS_CREATE];
const OPERATOR = [PERMISSIONS.SHIFTS_MANAGE];

describe('Shifts (start/end + day summary)', () => {
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

  it('starts and ends a shift, rejecting a double-start and a stray end', async () => {
    const tenant = await createTestTenant([...OFFICE, ...OPERATOR]);
    const token = await login(tenant.username);
    await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Dana Driver');

    const noneYet = await request(app.getHttpServer()).get('/v1/shifts/current').set('Authorization', `Bearer ${token}`).expect(200);
    expect(noneYet.body.shift).toBeNull();

    const started = await request(app.getHttpServer()).post('/v1/shifts/start').set('Authorization', `Bearer ${token}`).expect(201);
    expect(started.body.status).toBe('ACTIVE');
    expect(started.body.endedAt).toBeNull();

    const dupe = await request(app.getHttpServer()).post('/v1/shifts/start').set('Authorization', `Bearer ${token}`).expect(409);
    expect(dupe.body.error.code).toBe('SHIFT_ALREADY_ACTIVE');

    const current = await request(app.getHttpServer()).get('/v1/shifts/current').set('Authorization', `Bearer ${token}`).expect(200);
    expect(current.body.shift.id).toBe(started.body.id);

    const ended = await request(app.getHttpServer()).post('/v1/shifts/end').set('Authorization', `Bearer ${token}`).expect(201);
    expect(ended.body.status).toBe('ENDED');
    expect(ended.body.endedAt).toBeTruthy();

    const strayEnd = await request(app.getHttpServer()).post('/v1/shifts/end').set('Authorization', `Bearer ${token}`).expect(409);
    expect(strayEnd.body.error.code).toBe('SHIFT_NOT_ACTIVE');
  });

  it('rejects starting a shift for a caller with no linked Operator', async () => {
    const office = await createTestTenant(OPERATOR);
    const token = await login(office.username);
    const res = await request(app.getHttpServer()).post('/v1/shifts/start').set('Authorization', `Bearer ${token}`).expect(409);
    expect(res.body.error.code).toBe('SHIFT_OPERATOR_REQUIRED');
  });

  it('summarises today’s shifts per operator, and lists shift history', async () => {
    const tenant = await createTestTenant([...OFFICE, ...OPERATOR]);
    const token = await login(tenant.username);
    await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Dana Driver');

    await request(app.getHttpServer()).post('/v1/shifts/start').set('Authorization', `Bearer ${token}`).expect(201);
    await request(app.getHttpServer()).post('/v1/shifts/end').set('Authorization', `Bearer ${token}`).expect(201);

    const summary = await request(app.getHttpServer()).get('/v1/shifts/summary').set('Authorization', `Bearer ${token}`).expect(200);
    expect(summary.body.operators).toHaveLength(1);
    expect(summary.body.operators[0].name).toBe('Dana Driver');
    expect(summary.body.operators[0].shifts).toHaveLength(1);
    expect(summary.body.operators[0].totalMinutes).toBeGreaterThanOrEqual(0);

    const list = await request(app.getHttpServer()).get('/v1/shifts').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].operator.fullName).toBe('Dana Driver');

    // Shift history now accepts the shared page/pageSize params (previously a
    // hard 400) and returns the standard paginated envelope.
    const paged = await request(app.getHttpServer())
      .get('/v1/shifts?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(paged.body).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(paged.body.items).toHaveLength(1);
  });

  it('is tenant-isolated and requires shifts:view for the summary/history endpoints', async () => {
    const a = await createTestTenant([...OFFICE, ...OPERATOR]);
    await createOperatorLinkedToUser(a.companyId, a.userId, 'A Driver');
    const tokenA = await login(a.username);
    await request(app.getHttpServer()).post('/v1/shifts/start').set('Authorization', `Bearer ${tokenA}`).expect(201);

    const b = await createTestTenant(OFFICE);
    const tokenB = await login(b.username);
    const listB = await request(app.getHttpServer()).get('/v1/shifts').set('Authorization', `Bearer ${tokenB}`).expect(200);
    expect(listB.body.items).toHaveLength(0);

    const noPerm = await createTestTenant([]);
    const tokenNoPerm = await login(noPerm.username);
    const res = await request(app.getHttpServer()).get('/v1/shifts/summary').set('Authorization', `Bearer ${tokenNoPerm}`).expect(403);
    expect(res.body.error.requiredPermission).toBe(PERMISSIONS.SHIFTS_VIEW);
  });
});
