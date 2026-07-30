import { Injectable } from '@nestjs/common';
import { JobStatus, MaintenanceJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MaintenanceSchedulesService } from '../maintenance-schedules/maintenance-schedules.service';

/**
 * Operational counts for the dashboard's "Operations snapshot" and "Fleet
 * utilisation" widgets. The tile figures are live; the "vs yesterday" deltas and
 * the utilisation trend come from real daily snapshots the scheduler accumulates
 * (utilisation_snapshots) — never a fabricated baseline or back-filled history.
 *
 *  - assetsActive:     non-archived assets in the fleet.
 *  - assetsInWorkshop: assets with at least one open (non-COMPLETE) maintenance
 *                      job — the honest proxy for "off road", since Asset has no
 *                      status field by design (Asset model doc comment).
 *  - servicesDue:      overdue + due-soon asset maintenance plans.
 *  - openDefects:      open maintenance jobs a driver raised (reportedByOperatorId
 *                      set) — the workshop's live defect backlog from the road.
 *  - assetsOnActiveJob: distinct assets currently assigned to a dispatch job in
 *                      progress; the numerator of live fleet utilisation.
 */
@Injectable()
export class DashboardMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maintenanceSchedules: MaintenanceSchedulesService,
  ) {}

  /** The four asset/maintenance/dispatch counts, computed live in one tenant tx. */
  private async rawCounts(tx: Prisma.TransactionClient) {
    const [assetsActive, workshopRows, openDefects, busyRows] = await Promise.all([
      tx.asset.count({ where: { archivedAt: null } }),
      tx.maintenanceJob.findMany({ where: { status: { not: MaintenanceJobStatus.COMPLETE } }, select: { assetId: true }, distinct: ['assetId'] }),
      tx.maintenanceJob.count({ where: { status: { not: MaintenanceJobStatus.COMPLETE }, reportedByOperatorId: { not: null } } }),
      tx.job.findMany({ where: { status: JobStatus.ASSIGNED, assetId: { not: null } }, select: { assetId: true }, distinct: ['assetId'] }),
    ]);
    return { assetsActive, assetsInWorkshop: workshopRows.length, openDefects, assetsOnActiveJob: busyRows.length };
  }

  async metrics(companyId: string) {
    // servicesDue lives in the maintenance-schedules service (its own tenant tx);
    // run it alongside the core counts + prior-day snapshot lookup.
    const plansPromise = this.maintenanceSchedules.listAllPlans(companyId);
    const { counts, prior } = await this.prisma.withTenant(companyId, async (tx) => {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const [counts, prior] = await Promise.all([
        this.rawCounts(tx),
        // Excluded days don't seed a "vs yesterday" baseline.
        tx.utilisationSnapshot.findFirst({ where: { day: { lt: today }, sampleCount: { gt: 0 }, excluded: false }, orderBy: { day: 'desc' } }),
      ]);
      return { counts, prior };
    });
    const plans = await plansPromise;
    const servicesDue = (plans.overdueCount ?? 0) + (plans.dueSoonCount ?? 0);

    // A "vs yesterday" delta only where there's a real prior-day average to
    // compare against — otherwise deltas is null and the widget shows no chip.
    const avg = (sum: number) => Math.round(sum / prior!.sampleCount);
    const deltas = prior
      ? {
          assetsActive: counts.assetsActive - avg(prior.activeSum),
          assetsInWorkshop: counts.assetsInWorkshop - avg(prior.workshopSum),
          servicesDue: servicesDue - avg(prior.servicesDueSum),
          openDefects: counts.openDefects - avg(prior.defectsSum),
        }
      : null;

    return {
      ...counts,
      servicesDue,
      deltas,
      comparedTo: prior ? prior.day.toISOString().slice(0, 10) : null,
    };
  }

  /**
   * Fold the current reading into today's snapshot row. Called by the scheduler;
   * each tick adds the live counts and bumps the sample count, so the day
   * accumulates a real weighted average rather than one arbitrary reading.
   * Idempotent per (company, day) via upsert.
   */
  async recordSnapshot(companyId: string): Promise<{ busy: number; active: number }> {
    const plans = await this.maintenanceSchedules.listAllPlans(companyId);
    const servicesDue = (plans.overdueCount ?? 0) + (plans.dueSoonCount ?? 0);
    return this.prisma.withTenant(companyId, async (tx) => {
      const c = await this.rawCounts(tx);
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      await tx.utilisationSnapshot.upsert({
        where: { companyId_day: { companyId, day } },
        create: {
          companyId,
          day,
          busySum: c.assetsOnActiveJob,
          activeSum: c.assetsActive,
          workshopSum: c.assetsInWorkshop,
          defectsSum: c.openDefects,
          servicesDueSum: servicesDue,
          sampleCount: 1,
        },
        update: {
          busySum: { increment: c.assetsOnActiveJob },
          activeSum: { increment: c.assetsActive },
          workshopSum: { increment: c.assetsInWorkshop },
          defectsSum: { increment: c.openDefects },
          servicesDueSum: { increment: servicesDue },
          sampleCount: { increment: 1 },
        },
      });
      return { busy: c.assetsOnActiveJob, active: c.assetsActive };
    });
  }

  /**
   * The utilisation trend over the last `days` calendar days: one point per day
   * that has a snapshot, each the day's real weighted-average utilisation. Days
   * with no samples are simply absent (a new company's trend fills in over
   * time) — never back-filled with an invented figure.
   */
  async trend(companyId: string, days: number) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const from = new Date();
      from.setUTCHours(0, 0, 0, 0);
      from.setUTCDate(from.getUTCDate() - (days - 1));
      const rows = await tx.utilisationSnapshot.findMany({ where: { day: { gte: from }, excluded: false }, orderBy: { day: 'asc' } });
      const points = rows.map((r) => ({
        date: r.day.toISOString().slice(0, 10),
        utilisation: r.activeSum > 0 ? Math.round((r.busySum / r.activeSum) * 100) : 0,
        assetsOnActiveJob: r.sampleCount > 0 ? Math.round(r.busySum / r.sampleCount) : 0,
        assetsActive: r.sampleCount > 0 ? Math.round(r.activeSum / r.sampleCount) : 0,
      }));
      return { points };
    });
  }
}
