/**
 * Security audit log: proves security-relevant events are recorded (a failed
 * login, a successful login, a Privacy Act data export), that the trail is
 * readable only with audit:view, and that it is tenant-isolated by RLS.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const FULL = [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.OPERATORS_CREATE, PERMISSIONS.PRIVACY_EXPORT_DATA];
const USER_ADMIN = [PERMISSIONS.AUDIT_VIEW, PERMISSIONS.USERS_CREATE, PERMISSIONS.USERS_VIEW, PERMISSIONS.ROLES_VIEW];

describe('Security audit log', () => {
  let app: INestApplication;
  // The BYPASSRLS auth role can read system-level (null-company) audit rows —
  // failed logins that aren't attributable to any one tenant.
  const systemPrisma = new PrismaClient({ datasources: { db: { url: process.env.AUTH_DATABASE_URL } } });

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await systemPrisma.$disconnect();
    await disconnectFixtures();
  });

  function login(username: string, password = TEST_PASSWORD) {
    return request(app.getHttpServer()).post('/v1/auth/login').send({ username, password });
  }
  async function token(username: string): Promise<string> {
    const res = await login(username).expect(200);
    return res.body.accessToken as string;
  }

  /** The login/logout audit writes are fire-and-forget, so poll briefly. */
  async function findEvent(auth: string, action: string): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app.getHttpServer()).get('/v1/audit-logs').set('Authorization', `Bearer ${auth}`).expect(200);
      const hit = (res.body.items as { action: string }[]).find((e) => e.action === action);
      if (hit) return hit as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  }

  it('records a data export synchronously and login events, readable via the endpoint', async () => {
    const tenant = await createTestTenant(FULL);
    const auth = await token(tenant.username);

    // A Privacy Act export is recorded atomically (recordInTx) — deterministic.
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${auth}`)
      .send({ fullName: 'Audit Target' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v1/operators/${operator.body.id}/data-export`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(200);

    const listed = await request(app.getHttpServer()).get('/v1/audit-logs').set('Authorization', `Bearer ${auth}`).expect(200);
    const exportEvent = (listed.body.items as { action: string; targetId: string }[]).find((e) => e.action === 'privacy.data_exported');
    expect(exportEvent).toBeDefined();
    expect(exportEvent!.targetId).toBe(operator.body.id);

    // The successful login was recorded too (async).
    expect(await findEvent(auth, 'auth.login_succeeded')).toBeDefined();
  });

  it('records a failed login as a system-level failure event', async () => {
    const tenant = await createTestTenant(FULL);
    await login(tenant.username, 'wrong-password-123').expect(401);

    // A failed attempt isn't attributable to a company (multi-company users), so
    // it's recorded system-level and read back via the BYPASSRLS auth role.
    let failed: { outcome: string } | null = null;
    for (let i = 0; i < 12 && !failed; i += 1) {
      failed = await systemPrisma.auditLog.findFirst({
        where: { action: 'auth.login_failed', actorLabel: tenant.username },
        select: { outcome: true },
      });
      if (!failed) await new Promise((r) => setTimeout(r, 50));
    }
    expect(failed).not.toBeNull();
    expect(failed!.outcome).toBe('failure');
  });

  it('records an admin creating a user as an access-control event (atomic)', async () => {
    const tenant = await createTestTenant(USER_ADMIN);
    const auth = await token(tenant.username);

    // Assign the new user to the tenant's existing role.
    const roles = await request(app.getHttpServer()).get('/v1/roles').set('Authorization', `Bearer ${auth}`).expect(200);
    const roleId = (roles.body.items as { id: string }[])[0].id;

    const created = await request(app.getHttpServer())
      .post('/v1/users')
      .set('Authorization', `Bearer ${auth}`)
      .send({ username: `made-${tenant.username}`, fullName: 'Made User', password: TEST_PASSWORD, roleId })
      .expect(201);

    // recordInTx ⇒ the audit line is committed with the user, so it's readable
    // immediately (no polling needed).
    const listed = await request(app.getHttpServer()).get('/v1/audit-logs').set('Authorization', `Bearer ${auth}`).expect(200);
    const event = (listed.body.items as { action: string; targetId: string }[]).find((e) => e.action === 'access.user_created');
    expect(event).toBeDefined();
    expect(event!.targetId).toBe(created.body.userId);
  });

  it('requires audit:view to read the log', async () => {
    const noPerm = await createTestTenant([PERMISSIONS.OPERATORS_CREATE]);
    const auth = await token(noPerm.username);
    await request(app.getHttpServer()).get('/v1/audit-logs').set('Authorization', `Bearer ${auth}`).expect(403);
  });

  it('exports the audit log as a CSV download with the expected header row and the tenant\'s events', async () => {
    const tenant = await createTestTenant(FULL);
    const auth = await token(tenant.username);

    // Generate a deterministic, synchronously-recorded event to appear in the CSV.
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${auth}`)
      .send({ fullName: 'Export Target' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v1/operators/${operator.body.id}/data-export`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/v1/audit-logs/export')
      .set('Authorization', `Bearer ${auth}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-log-.*\.csv"/);

    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('id,createdAt,action,outcome,actorUserId,actorLabel,targetType,targetId,ip,requestId,metadata');
    // The privacy export event is in the CSV body, scoped to this tenant.
    expect(res.text).toContain('privacy.data_exported');
    expect(res.text).toContain(operator.body.id);
  });

  it('honours the same filters as the browse when exporting', async () => {
    const tenant = await createTestTenant(FULL);
    const auth = await token(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${auth}`)
      .send({ fullName: 'Filter Target' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/v1/operators/${operator.body.id}/data-export`)
      .set('Authorization', `Bearer ${auth}`)
      .expect(200);

    // A filter that matches no rows yields a header-only CSV.
    const res = await request(app.getHttpServer())
      .get('/v1/audit-logs/export')
      .query({ action: 'auth.mfa_disabled' })
      .set('Authorization', `Bearer ${auth}`)
      .expect(200);
    const lines = res.text.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(res.text).not.toContain('privacy.data_exported');
  });

  it('requires audit:view to export the log', async () => {
    const noPerm = await createTestTenant([PERMISSIONS.OPERATORS_CREATE]);
    const auth = await token(noPerm.username);
    await request(app.getHttpServer()).get('/v1/audit-logs/export').set('Authorization', `Bearer ${auth}`).expect(403);
  });

  it('is tenant-isolated — one company never sees another company\'s events', async () => {
    const a = await createTestTenant(FULL);
    const b = await createTestTenant(FULL);
    const authA = await token(a.username);
    const authB = await token(b.username);

    // A's login event exists for A…
    expect(await findEvent(authA, 'auth.login_succeeded')).toBeDefined();
    // …and B's log only contains B's own actor, never A's username.
    const listedB = await request(app.getHttpServer()).get('/v1/audit-logs').set('Authorization', `Bearer ${authB}`).expect(200);
    const labels = (listedB.body.items as { actorLabel: string | null }[]).map((e) => e.actorLabel);
    expect(labels).not.toContain(a.username);
  });
});
