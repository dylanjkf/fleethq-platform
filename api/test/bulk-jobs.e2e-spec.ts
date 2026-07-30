/**
 * Bulk job creation (Wave J2): a dispatcher plans a whole day of runs at once.
 * Same per-row-independent contract as every other bulk path, and a scheduled
 * run must land in the Upcoming view — the gap that made that tab permanently
 * empty from the UI.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [PERMISSIONS.DISPATCH_VIEW, PERMISSIONS.DISPATCH_CREATE];

describe('Bulk job creation', () => {
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

  it('creates many runs at once, and one invalid row does not fail the rest', async () => {
    const t = await createTestTenant(FULL);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const res = await request(app.getHttpServer())
      .post('/v1/jobs/bulk')
      .set(auth)
      .send({
        rows: [
          { title: 'Monday north run' },
          { title: 'Monday south run' },
          { title: '' }, // invalid — title required
          { title: 'Airport freight' },
        ],
      })
      .expect(201);

    expect(res.body).toMatchObject({ total: 4, createdCount: 3, invalidCount: 1 });
    expect(res.body.rows[2]).toMatchObject({ index: 2, created: false });

    const list = await request(app.getHttpServer()).get('/v1/jobs').set(auth).query({ pageSize: 50 }).expect(200);
    const titles = list.body.items.map((j: { title: string }) => j.title).sort();
    expect(titles).toEqual(['Airport freight', 'Monday north run', 'Monday south run']);
  });

  it('schedules runs ahead so they land in the Upcoming view, not Today', async () => {
    const t = await createTestTenant(FULL);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };

    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await request(app.getHttpServer())
      .post('/v1/jobs/bulk')
      .set(auth)
      .send({ rows: [{ title: 'Planned run A', scheduledAt: nextWeek }, { title: 'Planned run B', scheduledAt: nextWeek }] })
      .expect(201);

    const upcoming = await request(app.getHttpServer()).get('/v1/jobs').set(auth).query({ view: 'upcoming' }).expect(200);
    expect(upcoming.body.items.map((j: { title: string }) => j.title).sort()).toEqual(['Planned run A', 'Planned run B']);

    const today = await request(app.getHttpServer()).get('/v1/jobs').set(auth).query({ view: 'today' }).expect(200);
    expect(today.body.items.some((j: { title: string }) => j.title.startsWith('Planned run'))).toBe(false);
  });

  it('requires dispatch:create', async () => {
    const t = await createTestTenant([PERMISSIONS.DISPATCH_VIEW]);
    const auth = { Authorization: `Bearer ${await login(t.username)}` };
    const denied = await request(app.getHttpServer())
      .post('/v1/jobs/bulk')
      .set(auth)
      .send({ rows: [{ title: 'Nope' }] })
      .expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.DISPATCH_CREATE);
  });
});
