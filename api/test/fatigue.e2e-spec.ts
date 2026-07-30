/**
 * Fatigue/Hours tracking (08-Compliance/Australian_Compliance.md): the AU
 * Standard Hours rule set evaluated against OperatorShift history. Covers
 * the rule engine's three checks (24h work, 24h rest, 7-day work), the
 * shift-end breach Timeline event, the Dispatch assign-time risk check +
 * distinctly-logged override, permission gating, and tenant isolation.
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { buildTestApp } from './utils/build-test-app';
import {
  TEST_PASSWORD,
  createOperatorLinkedToUser,
  createShift,
  createTestTenant,
  disconnectFixtures,
  ensureAssetClasses,
  ensurePermissions,
} from './utils/fixtures';

const HOUR_MS = 60 * 60 * 1000;
function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * HOUR_MS);
}

const ownerPrisma = new PrismaClient();

describe('Fatigue / Hours tracking', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildTestApp();
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  async function login(username: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/v1/auth/login').send({ username, password: TEST_PASSWORD }).expect(200);
    return res.body.accessToken as string;
  }

  it('reports ok (nothing to flag) for an operator with no shift history at all', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'No Shifts Yet' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.workMinutesLast24h).toBe(0);
  });

  it('reports not_assessed for a company in a jurisdiction with no registered rule set', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    await ownerPrisma.company.update({ where: { id: tenant.companyId }, data: { jurisdiction: 'NZ' } });
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Unassessed Jurisdiction Operator' })
      .expect(201);
    await createShift(tenant.companyId, operator.body.id, hoursAgo(14), hoursAgo(1));

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('not_assessed');
    expect(res.body.ruleSetName).toBeNull();
  });

  it('reports ok for a normal single shift', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Normal Shift Operator' })
      .expect(201);
    await createShift(tenant.companyId, operator.body.id, hoursAgo(8), new Date());

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.breaches).toHaveLength(0);
    expect(res.body.workMinutesLast24h).toBe(480);
  });

  it('detects a 24h max-work-hours breach', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Overworked Operator' })
      .expect(201);
    // 13h shift, entirely within the trailing 24h window.
    await createShift(tenant.companyId, operator.body.id, hoursAgo(14), hoursAgo(1));

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('breach');
    expect(res.body.breaches.map((b: { rule: string }) => b.rule)).toContain('MAX_WORK_24H');
    expect(res.body.workMinutesLast24h).toBe(13 * 60);
  });

  it('reports approaching_limit just under the 24h max-work threshold', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Almost There Operator' })
      .expect(201);
    // 11h45 shift -> 705 minutes, within the 60-minute approaching buffer below the 720-minute (12h) limit.
    await createShift(tenant.companyId, operator.body.id, hoursAgo(11.75), new Date());

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('approaching_limit');
    expect(res.body.approaching.map((b: { rule: string }) => b.rule)).toContain('MAX_WORK_24H');
    expect(res.body.breaches).toHaveLength(0);
  });

  it('detects a 24h minimum-continuous-rest breach from fragmented shifts', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Fragmented Rest Operator' })
      .expect(201);
    // Four 1h shifts each 6h apart -> total work 4h (well under 12h) but no
    // single continuous rest gap reaches the 7h minimum.
    await createShift(tenant.companyId, operator.body.id, hoursAgo(24), hoursAgo(23));
    await createShift(tenant.companyId, operator.body.id, hoursAgo(17), hoursAgo(16));
    await createShift(tenant.companyId, operator.body.id, hoursAgo(10), hoursAgo(9));
    await createShift(tenant.companyId, operator.body.id, hoursAgo(3), hoursAgo(2));

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('breach');
    expect(res.body.breaches.map((b: { rule: string }) => b.rule)).toContain('MIN_REST_24H');
    expect(res.body.breaches.map((b: { rule: string }) => b.rule)).not.toContain('MAX_WORK_24H');
    expect(res.body.longestRestMinutesLast24h).toBeLessThan(7 * 60);
  });

  it('detects a 7-day max-work-hours breach without tripping the 24h rules', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Long Week Operator' })
      .expect(201);
    // Six 12h shifts spread across the last 7 days, each ending well over
    // 24h ago (so none overlap the trailing-24h window) -> 72h total in 7
    // days, exactly at the Standard Hours weekly limit.
    const startHoursAgo = [167, 144, 120, 96, 72, 48];
    for (const start of startHoursAgo) {
      await createShift(tenant.companyId, operator.body.id, hoursAgo(start), hoursAgo(start - 12));
    }

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('breach');
    expect(res.body.breaches.map((b: { rule: string }) => b.rule)).toEqual(['MAX_WORK_7D']);
    expect(res.body.workMinutesLast24h).toBe(0);
    expect(res.body.workMinutesLast7d).toBe(72 * 60);
  });

  it('detects a 7-day minimum-continuous-rest breach even when daily/weekly work totals are both fine', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'No Real Day Off Operator' })
      .expect(201);
    // Seven 3h shifts, one every 24h, each 21h apart -> only 21h total work
    // across the week (well under the 72h/7d limit) and every single-day
    // rest gap comfortably clears the 7h/24h minimum, but no gap anywhere
    // in the trailing 7 days ever reaches the 24h continuous-rest minimum
    // Standard Hours also requires per week.
    const startHoursAgo = [150, 126, 102, 78, 54, 30, 6];
    for (const start of startHoursAgo) {
      await createShift(tenant.companyId, operator.body.id, hoursAgo(start), hoursAgo(start - 3));
    }

    const res = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.status).toBe('breach');
    expect(res.body.breaches.map((b: { rule: string }) => b.rule)).toEqual(['MIN_REST_7D']);
    expect(res.body.longestRestMinutesLast7d).toBeLessThan(24 * 60);
    expect(res.body.workMinutesLast7d).toBe(7 * 3 * 60);
  });

  it('lists at-risk operators for the Compliance dashboard, excluding ok/no-history operators', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);

    const atRisk = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'At Risk Operator' })
      .expect(201);
    await createShift(tenant.companyId, atRisk.body.id, hoursAgo(14), hoursAgo(1));

    const fine = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Fine Operator' })
      .expect(201);
    await createShift(tenant.companyId, fine.body.id, hoursAgo(2), new Date());

    const noHistory = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'No History Operator' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/v1/fatigue/at-risk').set('Authorization', `Bearer ${token}`).expect(200);
    const ids = res.body.map((s: { operatorId: string }) => s.operatorId);
    expect(ids).toContain(atRisk.body.id);
    expect(ids).not.toContain(fine.body.id);
    expect(ids).not.toContain(noHistory.body.id);
  });

  it("lets an operator read their own status via /fatigue/me with no compliance:view permission", async () => {
    const tenant = await createTestTenant([PERMISSIONS.SHIFTS_MANAGE]);
    const token = await login(tenant.username);
    const operatorId = await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Self Reader');

    const res = await request(app.getHttpServer()).get('/v1/fatigue/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.operatorId).toBe(operatorId);
    expect(res.body.status).toBe('ok');
  });

  it('records a fatigue_breach Timeline event automatically when a shift ends over the limit', async () => {
    const tenant = await createTestTenant([PERMISSIONS.SHIFTS_MANAGE, PERMISSIONS.TIMELINE_VIEW]);
    const token = await login(tenant.username);
    const operatorId = await createOperatorLinkedToUser(tenant.companyId, tenant.userId, 'Breach On End');
    // A 13h shift already logged in the trailing 24h window; ending a fresh
    // (near-instant) shift now should push the caller over the 12h limit
    // and be caught right at that moment.
    await createShift(tenant.companyId, operatorId, hoursAgo(14), hoursAgo(1));

    await request(app.getHttpServer()).post('/v1/shifts/start').set('Authorization', `Bearer ${token}`).expect(201);
    await request(app.getHttpServer()).post('/v1/shifts/end').set('Authorization', `Bearer ${token}`).expect(201);

    const timeline = await request(app.getHttpServer())
      .get(`/v1/timeline?entityType=OPERATOR&entityId=${operatorId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const breachEvent = timeline.body.items.find((e: { eventType: string }) => e.eventType === 'fatigue_breach');
    expect(breachEvent).toBeTruthy();
  });

  it('blocks assigning a fatigued operator without acknowledgement, then allows it with an override logged distinctly', async () => {
    const tenant = await createTestTenant([
      PERMISSIONS.DISPATCH_VIEW,
      PERMISSIONS.DISPATCH_CREATE,
      PERMISSIONS.DISPATCH_ASSIGN,
      PERMISSIONS.ASSETS_CREATE,
      PERMISSIONS.OPERATORS_CREATE,
      PERMISSIONS.TIMELINE_VIEW,
    ]);
    const token = await login(tenant.username);

    const asset = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Fatigue Test Truck' })
      .expect(201);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Fatigued Operator' })
      .expect(201);
    await createShift(tenant.companyId, operator.body.id, hoursAgo(14), hoursAgo(1));

    const job = await request(app.getHttpServer())
      .post('/v1/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Risky assignment' })
      .expect(201);

    const blocked = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id })
      .expect(409);
    expect(blocked.body.error.code).toBe('FATIGUE_RISK_UNACKNOWLEDGED');
    expect(blocked.body.error.fatigueStatus.status).toBe('breach');

    const stillUnassigned = await request(app.getHttpServer())
      .get(`/v1/jobs/${job.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(stillUnassigned.body.status).toBe('UNASSIGNED');

    const overridden = await request(app.getHttpServer())
      .post(`/v1/jobs/${job.body.id}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetId: asset.body.id, operatorId: operator.body.id, acknowledgeFatigueRisk: true })
      .expect(201);
    expect(overridden.body.status).toBe('ASSIGNED');

    const timeline = await request(app.getHttpServer())
      .get(`/v1/timeline?entityType=OPERATOR&entityId=${operator.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const overrideEvent = timeline.body.items.find((e: { eventType: string }) => e.eventType === 'fatigue_risk_overridden');
    expect(overrideEvent).toBeTruthy();
    expect(overrideEvent.payload.status).toBe('breach');
  });

  it('is gated on compliance:view for /at-risk and /operators/:id, and tenant-isolated', async () => {
    const tenant = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW, PERMISSIONS.OPERATORS_CREATE]);
    const token = await login(tenant.username);
    const operator = await request(app.getHttpServer())
      .post('/v1/operators')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Isolated Operator' })
      .expect(201);
    await createShift(tenant.companyId, operator.body.id, hoursAgo(14), hoursAgo(1));

    const noPerm = await createTestTenant([]);
    const noPermToken = await login(noPerm.username);
    const denied = await request(app.getHttpServer())
      .get(`/v1/fatigue/operators/${operator.body.id}`)
      .set('Authorization', `Bearer ${noPermToken}`)
      .expect(403);
    expect(denied.body.error.requiredPermission).toBe(PERMISSIONS.COMPLIANCE_VIEW);

    const other = await createTestTenant([PERMISSIONS.COMPLIANCE_VIEW]);
    const otherToken = await login(other.username);
    const atRiskOther = await request(app.getHttpServer()).get('/v1/fatigue/at-risk').set('Authorization', `Bearer ${otherToken}`).expect(200);
    expect(atRiskOther.body).toHaveLength(0);
  });
});
