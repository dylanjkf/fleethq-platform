/**
 * Scale check for the hot reporting path. Seeds a single tenant with a large
 * volume of delivery stops, then proves the reporting query (a) stays correct,
 * (b) uses the composite index added for it (`job_stops_company_id_completed_at_idx`)
 * rather than a full table scan, and (c) returns within a generous time budget.
 *
 * This is the honest, repeatable stand-in for a production load test: it can't
 * simulate concurrency or a 100k-tenant fleet, but it does prove the index
 * choice holds and the query doesn't degrade to a sequential scan as one
 * tenant's delivery history grows.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient, StopOutcome } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;
const STOP_COUNT = 12_000; // one tenant, ~a year of delivery history

const FULL = [PERMISSIONS.REPORTS_VIEW, PERMISSIONS.DISPATCH_CREATE, PERMISSIONS.ASSETS_CREATE];

describe('Scale / performance (reporting on a large tenant)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await ownerPrisma.$disconnect();
    await disconnectFixtures();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it(`keeps impact reporting correct, index-backed and fast with ${STOP_COUNT} stops`, async () => {
    const tenant = await createTestTenant(FULL);
    const token = await login(tenant.username);
    const job = await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Scale run' }).expect(201);
    const jobId = job.body.id as string;

    // Bulk-seed via the owner role (bypasses RLS) in batches. completedAt is
    // spread over the last ~300 days so every stop lands inside a 12-month
    // report window and the delivered count is deterministic.
    const now = Date.now();
    for (let start = 0; start < STOP_COUNT; start += 4000) {
      const batch = [];
      for (let i = start; i < Math.min(start + 4000, STOP_COUNT); i++) {
        batch.push({
          companyId: tenant.companyId,
          jobId,
          sequence: i,
          label: `Stop ${i}`,
          outcome: StopOutcome.DELIVERED,
          completedAt: new Date(now - (i % 300) * DAY_MS - 60_000),
        });
      }
      await ownerPrisma.jobStop.createMany({ data: batch });
    }
    // Give the planner real statistics for this table before we measure it.
    await ownerPrisma.$executeRawUnsafe('ANALYZE job_stops');

    // (a) The composite index exists.
    const indexes = await ownerPrisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'job_stops'`,
    );
    expect(indexes.map((r) => r.indexname)).toContain('job_stops_company_id_completed_at_idx');

    // (b) A selective company+date-range scan uses that index, not a Seq Scan.
    const from = new Date(now - 2 * DAY_MS);
    const to = new Date(now);
    const plan = (
      await ownerPrisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT count(*) FROM job_stops WHERE company_id = '${tenant.companyId}'::uuid AND completed_at BETWEEN '${from.toISOString()}' AND '${to.toISOString()}'`,
      )
    )
      .map((r) => r['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain('job_stops_company_id_completed_at_idx');
    expect(plan).not.toMatch(/Seq Scan on job_stops/);

    // (c) The user-facing endpoint stays correct and within budget at this size.
    const started = Date.now();
    const res = await request(app.getHttpServer()).get('/v1/reports/impact').query({ months: 12 }).set('Authorization', `Bearer ${token}`).expect(200);
    const elapsed = Date.now() - started;

    expect(res.body.headline.deliveriesProven).toBe(STOP_COUNT);
    expect(elapsed).toBeLessThan(4000);
  }, 60_000);
});
