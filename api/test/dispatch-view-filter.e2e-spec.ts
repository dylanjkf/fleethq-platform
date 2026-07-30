/**
 * Dispatch date filter (Today/Upcoming/History): a 3-way partition every job
 * falls into exactly one of — history (terminal, any date), upcoming (active,
 * scheduled after today), today (active and unscheduled or due today/earlier).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [PERMISSIONS.DISPATCH_VIEW, PERMISSIONS.DISPATCH_CREATE, PERMISSIONS.DISPATCH_CANCEL];

describe('Dispatch date filter (view=today/upcoming/history)', () => {
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

  it('partitions unscheduled, future-scheduled, and terminal jobs into today/upcoming/history', async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const create = (title: string, scheduledAt?: string) =>
      request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title, scheduledAt }).expect(201);

    const unscheduled = await create('Unscheduled run');
    const dueToday = await create('Due today', new Date().toISOString());
    const future = await create('Future run', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString());
    const toCancel = await create('Will be cancelled');
    await request(app.getHttpServer()).post(`/v1/jobs/${toCancel.body.id}/cancel`).set('Authorization', `Bearer ${token}`).expect(201);

    const today = await request(app.getHttpServer()).get('/v1/jobs').query({ view: 'today', pageSize: 100 }).set('Authorization', `Bearer ${token}`).expect(200);
    const todayIds = today.body.items.map((j: { id: string }) => j.id);
    expect(todayIds).toEqual(expect.arrayContaining([unscheduled.body.id, dueToday.body.id]));
    expect(todayIds).not.toContain(future.body.id);
    expect(todayIds).not.toContain(toCancel.body.id);

    const upcoming = await request(app.getHttpServer()).get('/v1/jobs').query({ view: 'upcoming', pageSize: 100 }).set('Authorization', `Bearer ${token}`).expect(200);
    const upcomingIds = upcoming.body.items.map((j: { id: string }) => j.id);
    expect(upcomingIds).toEqual([future.body.id]);

    const history = await request(app.getHttpServer()).get('/v1/jobs').query({ view: 'history', pageSize: 100 }).set('Authorization', `Bearer ${token}`).expect(200);
    const historyIds = history.body.items.map((j: { id: string }) => j.id);
    expect(historyIds).toEqual([toCancel.body.id]);
  });
});
