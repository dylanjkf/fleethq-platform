/**
 * Support & ops cockpit — customer 360 (B2). `GET /v1/admin/organisations/:id/cockpit`
 * assembles, from data that ALREADY exists, everything a FleetHQ staff member
 * needs to work a support conversation about one company: billing + grace state,
 * usage signals, currently-open flags, and the recent admin-activity feed. This
 * proves it composes accurate values from the real underlying rows and is
 * read-only + permission-gated.
 */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import { TEST_PASSWORD, createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';
import { createTestAdmin, disconnectAdminFixtures, TEST_ADMIN_PASSWORD } from './utils/admin-fixtures';

const ownerPrisma = new PrismaClient();

describe('Cockpit customer 360 (B2)', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    await ensurePermissions();
    await ensureAssetClasses();
    app = await buildTestApp();
    const admin = await createTestAdmin([ADMIN_PERMISSIONS.ORGANISATIONS_VIEW]);
    const res = await request(app.getHttpServer())
      .post('/v1/admin/auth/login')
      .send({ username: admin.username, password: TEST_ADMIN_PASSWORD })
      .expect(200);
    adminToken = res.body.accessToken as string;
  });
  afterAll(async () => {
    await app.close();
    await ownerPrisma.$disconnect();
    await disconnectFixtures();
    await disconnectAdminFixtures();
  });

  it('assembles accurate billing, usage, flags and recent-activity from the real underlying data', async () => {
    const tenant = await createTestTenant([PERMISSIONS.ASSETS_CREATE, PERMISSIONS.DISPATCH_CREATE]);
    const token = (await request(app.getHttpServer()).post('/v1/auth/login').send({ username: tenant.username, password: TEST_PASSWORD }).expect(200)).body
      .accessToken as string;

    // Real usage rows.
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Cockpit Truck A' }).expect(201);
    await request(app.getHttpServer()).post('/v1/assets').set('Authorization', `Bearer ${token}`).send({ name: 'Cockpit Truck B' }).expect(201);
    await request(app.getHttpServer()).post('/v1/jobs').set('Authorization', `Bearer ${token}`).send({ title: 'Cockpit Load 1' }).expect(201);

    // A live-subscription-past-due-in-grace billing state.
    const graceEnd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days out
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { subscriptionStatus: 'PAST_DUE', paymentFailureCount: 1, gracePeriodEndsAt: graceEnd },
    });

    // A feature-flag override for this company.
    const flag = await ownerPrisma.featureFlag.create({
      data: { key: `cockpit_${randomUUID().slice(0, 8)}`, name: 'Cockpit Beta', description: 'test', globalEnabled: false },
    });
    await ownerPrisma.featureFlagOverride.create({ data: { flagId: flag.id, companyId: tenant.companyId, enabled: true } });

    // A recent admin action scoped to this org (the same rows the Audit Log page reads).
    await ownerPrisma.adminAuditLog.create({
      data: { action: 'organisations.viewed_by_support', entityType: 'organisation', organisationId: tenant.companyId, ipAddress: '127.0.0.1' },
    });

    const body = (await request(app.getHttpServer()).get(`/v1/admin/organisations/${tenant.companyId}/cockpit`).set('Authorization', `Bearer ${adminToken}`).expect(200)).body;

    // Billing + grace.
    expect(body.billing.subscriptionStatus).toBe('PAST_DUE');
    expect(new Date(body.billing.gracePeriodEndsAt).getTime()).toBe(graceEnd.getTime());
    expect(body.flags.pastDue).toBe(true);
    expect(body.flags.inGrace).toBe(true); // grace deadline is in the future
    expect(body.flags.graceElapsed).toBe(false);

    // Usage — real counts + a last-active signal from the login above.
    expect(body.usage.assets).toBe(2);
    expect(body.usage.users).toBeGreaterThanOrEqual(1);
    expect(body.usage.recentJobs30d).toBe(1);
    expect(body.usage.lastActiveAt).toBeTruthy();

    // Open flags: the company's feature-flag override is surfaced.
    expect(body.flags.featureFlagOverrides).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: flag.key, name: 'Cockpit Beta', enabled: true })]),
    );

    // Recent activity: the seeded admin action shows up.
    expect(body.recentActivity.map((a: { action: string }) => a.action)).toContain('organisations.viewed_by_support');
  });

  it('surfaces the 12-month lock-in state: lockedIn true within term, and contractReleasedAt + lockedIn false once released', async () => {
    const tenant = await createTestTenant([]);
    const inTerm = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000); // ~200 days out

    // Within the minimum term, not released → a "cancel for me" request must be declined.
    await ownerPrisma.company.update({ where: { id: tenant.companyId }, data: { contractEndsAt: inTerm } });
    let body = (await request(app.getHttpServer()).get(`/v1/admin/organisations/${tenant.companyId}/cockpit`).set('Authorization', `Bearer ${adminToken}`).expect(200)).body;
    expect(new Date(body.billing.contractEndsAt).getTime()).toBe(inTerm.getTime());
    expect(body.billing.contractReleasedAt).toBeNull();
    expect(body.flags.lockedIn).toBe(true);

    // Released for cause → the lock-in flag clears and the release is visible to staff.
    const releasedAt = new Date();
    await ownerPrisma.company.update({
      where: { id: tenant.companyId },
      data: { contractReleasedAt: releasedAt, contractReleaseReason: 'Persistent outage' },
    });
    body = (await request(app.getHttpServer()).get(`/v1/admin/organisations/${tenant.companyId}/cockpit`).set('Authorization', `Bearer ${adminToken}`).expect(200)).body;
    expect(new Date(body.billing.contractReleasedAt).getTime()).toBe(releasedAt.getTime());
    expect(body.billing.contractReleaseReason).toBe('Persistent outage');
    expect(body.flags.lockedIn).toBe(false);
  });

  it('is gated on organisations:view (403 for an admin without it)', async () => {
    const tenant = await createTestTenant([]);
    const weak = await createTestAdmin([ADMIN_PERMISSIONS.SYSTEM_VIEW]);
    const weakToken = (await request(app.getHttpServer()).post('/v1/admin/auth/login').send({ username: weak.username, password: TEST_ADMIN_PASSWORD }).expect(200)).body
      .accessToken as string;
    await request(app.getHttpServer()).get(`/v1/admin/organisations/${tenant.companyId}/cockpit`).set('Authorization', `Bearer ${weakToken}`).expect(403);
  });
});
