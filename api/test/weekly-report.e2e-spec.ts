/**
 * Weekly operations report: the leader-elected scheduler's per-company job that
 * emails a 7-day operations summary (and raises an in-app notification) to
 * reports:view holders, without anyone logging in. Proves the report carries
 * REAL numbers aggregated from the tenant's own jobs/stops (reusing
 * ReportsService.operations), reaches reports:view holders by email + in-app,
 * and is idempotent (a second run in the same week does nothing).
 */
import { INestApplication } from '@nestjs/common';
import { PrismaClient, StopOutcome } from '@prisma/client';
import { PERMISSIONS } from '../src/common/permissions/permission-catalog';
import { NOTIFICATION_CHANNEL, type NotificationChannel } from '../src/notifications/channels/notification-channel';
import { WeeklyReportService, WEEKLY_REPORT_NOTIFICATION_TYPE } from '../src/reports/weekly-report.service';
import { buildTestApp } from './utils/build-test-app';
import { createTestTenant, disconnectFixtures, ensureAssetClasses, ensurePermissions } from './utils/fixtures';

const ownerPrisma = new PrismaClient();

describe('Weekly operations report', () => {
  let app: INestApplication;
  let weekly: WeeklyReportService;
  let channel: NotificationChannel;

  beforeAll(async () => {
    app = await buildTestApp();
    weekly = app.get(WeeklyReportService);
    channel = app.get<NotificationChannel>(NOTIFICATION_CHANNEL);
    await ensureAssetClasses();
    await ensurePermissions();
  });
  afterAll(async () => {
    await app.close();
    await disconnectFixtures();
    await ownerPrisma.$disconnect();
  });

  function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  it('emails a report with real numbers to reports:view holders, and is idempotent', async () => {
    const tenant = await createTestTenant([PERMISSIONS.REPORTS_VIEW]);
    // Give the recipient a real inbox — a holder without one is skipped (username
    // is a login handle, not an email), so this is required to exercise the send.
    await ownerPrisma.user.update({ where: { id: tenant.userId }, data: { email: 'ops@example.test' } });

    // Seed a week of delivery activity: 2 delivered (one within its promised
    // window → on-time), 1 failed. Bypasses RLS like the seed script / fixtures.
    const job = await ownerPrisma.job.create({
      data: { companyId: tenant.companyId, title: 'Weekly run', status: 'COMPLETED' },
    });
    const completedAt = daysAgo(1);
    await ownerPrisma.jobStop.createMany({
      data: [
        {
          companyId: tenant.companyId,
          jobId: job.id,
          sequence: 1,
          label: 'Stop 1',
          outcome: StopOutcome.DELIVERED,
          completedAt,
          windowEnd: new Date(completedAt.getTime() + 60 * 60 * 1000), // on-time
        },
        {
          companyId: tenant.companyId,
          jobId: job.id,
          sequence: 2,
          label: 'Stop 2',
          outcome: StopOutcome.DELIVERED,
          completedAt,
        },
        {
          companyId: tenant.companyId,
          jobId: job.id,
          sequence: 3,
          label: 'Stop 3',
          outcome: StopOutcome.FAILED,
          completedAt,
        },
      ],
    });

    const emailSpy = jest.spyOn(channel, 'sendEmail');

    const first = await weekly.sendWeeklyReport(tenant.companyId);
    expect(first).toEqual({ sent: true, recipients: 1 });

    // In-app notification landed, of the new type, carrying the tenant's REAL
    // numbers (2 delivered, 1 failed = 67%).
    const notes = await ownerPrisma.notification.findMany({
      where: { companyId: tenant.companyId, type: WEEKLY_REPORT_NOTIFICATION_TYPE },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].recipientUserId).toBe(tenant.userId);
    expect(notes[0].body).toContain('2 delivered, 1 failed (67%)');

    // Email sent to the holder's inbox, with the same real figures from
    // ReportsService.operations.
    const call = emailSpy.mock.calls.find((c) => c[0].to === 'ops@example.test');
    expect(call).toBeDefined();
    expect(call![0].subject).toContain('weekly report');
    expect(call![0].body).toContain('Deliveries: 2 completed, 1 failed (67% delivery rate)');
    expect(call![0].body).toContain('On-time: 1/1 within window (100%)');

    // Idempotent: a second run in the same week sends nothing and raises no new
    // notification.
    emailSpy.mockClear();
    const second = await weekly.sendWeeklyReport(tenant.companyId);
    expect(second).toEqual({ sent: false, recipients: 0 });
    const notesAfter = await ownerPrisma.notification.count({
      where: { companyId: tenant.companyId, type: WEEKLY_REPORT_NOTIFICATION_TYPE },
    });
    expect(notesAfter).toBe(1);
    expect(emailSpy.mock.calls.find((c) => c[0].to === 'ops@example.test')).toBeUndefined();

    emailSpy.mockRestore();
  });

  it('is tenant-scoped — one company\'s report never notifies another', async () => {
    const a = await createTestTenant([PERMISSIONS.REPORTS_VIEW]);
    const b = await createTestTenant([PERMISSIONS.REPORTS_VIEW]);

    await weekly.sendWeeklyReport(a.companyId);

    const bNotes = await ownerPrisma.notification.count({
      where: { companyId: b.companyId, type: WEEKLY_REPORT_NOTIFICATION_TYPE },
    });
    expect(bNotes).toBe(0);
  });
});
