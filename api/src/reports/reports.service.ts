import { Injectable } from '@nestjs/common';
import { MaintenanceJobStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ImpactReportDto } from './dto/impact-report.dto';
import { OperationsReportDto } from './dto/operations-report.dto';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';
import { mergeDowntimeMsByAsset } from './report-aggregation';

const DEFAULT_RANGE_DAYS = 7;
const DEFAULT_IMPACT_MONTHS = 6;

/**
 * Operational reporting (05-Dispatch v1 "basic reporting"): a read-model over a
 * date range for the fleet manager's daily view and the sales artifact —
 * deliveries completed/failed, pre-start checklist activity, open workshop jobs,
 * and a per-operator breakdown.
 *
 * Aggregation is pushed into SQL (grouped counts / sums), not `findMany` +
 * JS reduce: at fleet scale a 7-day window can hold millions of stops, and
 * loading every row into Node just to count them would blow memory and
 * latency. Every query runs inside `withTenant`, so RLS scopes each table to
 * the caller's company — the raw SQL never needs an explicit company filter,
 * exactly like the ORM calls it replaces. Nothing is stored.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async operations(companyId: string, query: OperationsReportDto) {
    const to = query.to ? endOfDay(new Date(query.to)) : endOfDay(new Date());
    const from = query.from ? startOfDay(new Date(query.from)) : startOfDay(addDays(to, -(DEFAULT_RANGE_DAYS - 1)));

    return this.prisma.withTenant(companyId, async (tx) => {
      const [[deliveryAgg], failureRows, operatorStopRows, checklistRows, costRows, openWorkshopJobs, openFaultWindows, totalAssets] =
        await Promise.all([
          // Delivery totals + on-time, in one grouped pass. On-time compares two
          // columns (completed_at <= window_end), which Prisma's `where` can't
          // express — the reason this is raw SQL rather than groupBy.
          tx.$queryRaw<{ delivered: bigint; failed: bigint; assessed: bigint; on_time: bigint }[]>`
            SELECT
              count(*) FILTER (WHERE outcome = 'DELIVERED') AS delivered,
              count(*) FILTER (WHERE outcome = 'FAILED') AS failed,
              count(*) FILTER (WHERE outcome = 'DELIVERED' AND window_end IS NOT NULL) AS assessed,
              count(*) FILTER (WHERE outcome = 'DELIVERED' AND window_end IS NOT NULL AND completed_at <= window_end) AS on_time
            FROM job_stops
            WHERE completed_at >= ${from} AND completed_at <= ${to} AND outcome IN ('DELIVERED', 'FAILED')
          `,
          // Failure-reason breakdown — "reason not given" is its own honest
          // bucket rather than silently folding into OTHER.
          tx.$queryRaw<{ reason: string; count: bigint }[]>`
            SELECT coalesce(failure_reason::text, 'NOT_RECORDED') AS reason, count(*) AS count
            FROM job_stops
            WHERE completed_at >= ${from} AND completed_at <= ${to} AND outcome = 'FAILED'
            GROUP BY 1
            ORDER BY count DESC
          `,
          // Per-operator delivery rollup (RLS scopes the joined jobs/operators
          // to the tenant too).
          tx.$queryRaw<{ operator_id: string | null; full_name: string | null; delivered: bigint; failed: bigint }[]>`
            SELECT j.operator_id, o.full_name,
              count(*) FILTER (WHERE s.outcome = 'DELIVERED') AS delivered,
              count(*) FILTER (WHERE s.outcome = 'FAILED') AS failed
            FROM job_stops s
            JOIN jobs j ON j.id = s.job_id
            LEFT JOIN operators o ON o.id = j.operator_id
            WHERE s.completed_at >= ${from} AND s.completed_at <= ${to} AND s.outcome IN ('DELIVERED', 'FAILED')
            GROUP BY j.operator_id, o.full_name
          `,
          // Checklist totals + per-operator counts in one grouped pass.
          tx.$queryRaw<{ operator_id: string | null; full_name: string | null; total: bigint; with_failures: bigint }[]>`
            SELECT cs.operator_id, o.full_name,
              count(*) AS total,
              count(*) FILTER (WHERE cs.has_failures) AS with_failures
            FROM checklist_submissions cs
            LEFT JOIN operators o ON o.id = cs.operator_id
            WHERE cs.submitted_at >= ${from} AND cs.submitted_at <= ${to}
            GROUP BY cs.operator_id, o.full_name
          `,
          // Cost trend: jobs closed within the window, summed per UTC day.
          // `completed_at` is a UTC-naive timestamp, so date_trunc gives the UTC
          // day — matching the JS dayKey (toISOString) used to zero-fill below.
          tx.$queryRaw<{ day_key: string; cost: number; jobs_with_cost: bigint }[]>`
            SELECT to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day_key,
              coalesce(sum(coalesce(parts_cost, 0) + coalesce(labor_cost, 0)), 0)::float8 AS cost,
              count(*) FILTER (WHERE parts_cost IS NOT NULL OR labor_cost IS NOT NULL) AS jobs_with_cost
            FROM maintenance_jobs
            WHERE completed_at >= ${from} AND completed_at <= ${to}
            GROUP BY 1
          `,
          tx.maintenanceJob.count({ where: { status: { not: MaintenanceJobStatus.COMPLETE } } }),
          // Uptime: a maintenance job takes its asset out of service while open.
          // A job overlapping the window counts, clipped to the window's edges.
          // Rows are merged into per-asset downtime intervals in JS, so cap the
          // load at MAX_AGGREGATION_ROWS — far above the jobs that realistically
          // overlap a report window, but a hard bound so a pathological backlog
          // of long-open jobs can't turn this into an unbounded scan.
          tx.maintenanceJob.findMany({
            where: { createdAt: { lte: to }, OR: [{ completedAt: null }, { completedAt: { gte: from } }] },
            select: { assetId: true, createdAt: true, completedAt: true },
            take: MAX_AGGREGATION_ROWS,
          }),
          tx.asset.count({ where: { archivedAt: null } }),
        ]);

      const delivered = Number(deliveryAgg.delivered);
      const failed = Number(deliveryAgg.failed);
      const totalStops = delivered + failed;

      // On-time is only assessable for a DELIVERED stop that actually had a
      // promised window — everything else is "not assessable".
      const assessed = Number(deliveryAgg.assessed);
      const onTimeCount = Number(deliveryAgg.on_time);
      const lateCount = assessed - onTimeCount;

      const failureReasonCounts = failureRows.map((r) => ({ reason: r.reason, count: Number(r.count) }));

      // Per-operator rollup across deliveries and checklists.
      const byOperator = new Map<string, { operatorId: string | null; name: string; delivered: number; failed: number; checklists: number }>();
      const bucket = (id: string | null, name: string) => {
        const key = id ?? 'unassigned';
        if (!byOperator.has(key)) byOperator.set(key, { operatorId: id, name, delivered: 0, failed: 0, checklists: 0 });
        return byOperator.get(key)!;
      };
      for (const r of operatorStopRows) {
        const row = bucket(r.operator_id, r.full_name ?? 'Unassigned');
        row.delivered += Number(r.delivered);
        row.failed += Number(r.failed);
      }
      let checklistsCompleted = 0;
      let checklistsWithFailures = 0;
      for (const r of checklistRows) {
        const total = Number(r.total);
        const withFailures = Number(r.with_failures);
        checklistsCompleted += total;
        checklistsWithFailures += withFailures;
        bucket(r.operator_id, r.full_name ?? 'Unassigned').checklists += total;
      }

      // Cost trend — one bucket per calendar day in the window, zero-filled so
      // a quiet day isn't just absent from the series.
      const costByDay = new Map<string, number>();
      for (const day of eachDay(from, to)) costByDay.set(day, 0);
      let totalCost = 0;
      let jobsWithCost = 0;
      for (const r of costRows) {
        totalCost += r.cost;
        jobsWithCost += Number(r.jobs_with_cost);
        costByDay.set(r.day_key, round2(r.cost));
      }
      totalCost = round2(totalCost);

      // Uptime — merge each asset's overlapping open-fault windows
      // (clipped to [from, to]) so simultaneous faults on one asset aren't
      // double-counted, then express the remainder as a percentage of the
      // window.
      const rangeMs = to.getTime() - from.getTime();
      const downtimeMsByAsset = mergeDowntimeMsByAsset(openFaultWindows, from, to);
      // Only fetch names for the (small) set of assets that actually had
      // downtime, rather than loading the whole fleet — and keep the original
      // rule that an archived asset's downtime doesn't count.
      const downtimeAssetIds = [...downtimeMsByAsset.keys()];
      const namedAssets = downtimeAssetIds.length
        ? await tx.asset.findMany({ where: { id: { in: downtimeAssetIds }, archivedAt: null }, select: { id: true, name: true } })
        : [];
      const totalDowntimeMs = namedAssets.reduce((sum, a) => sum + (downtimeMsByAsset.get(a.id) ?? 0), 0);
      const pct = (downtimeMs: number) => Math.max(0, Math.min(100, Math.round((1 - downtimeMs / rangeMs) * 100)));
      const fleetUptimePct = totalAssets === 0 || rangeMs <= 0 ? null : pct(totalDowntimeMs / totalAssets);
      const assetsWithDowntime = namedAssets
        .map((a) => {
          const downtimeMs = downtimeMsByAsset.get(a.id) ?? 0;
          if (downtimeMs <= 0) return null;
          return {
            assetId: a.id,
            assetName: a.name,
            downtimeHours: Math.round((downtimeMs / (60 * 60 * 1000)) * 10) / 10,
            uptimePct: pct(downtimeMs),
          };
        })
        .filter((x): x is { assetId: string; assetName: string; downtimeHours: number; uptimePct: number } => x !== null)
        .sort((a, b) => a.uptimePct - b.uptimePct);

      return {
        range: { from, to },
        deliveries: {
          total: totalStops,
          delivered,
          failed,
          deliveryRatePct: totalStops === 0 ? null : Math.round((delivered / totalStops) * 100),
          onTime: {
            assessed,
            onTimeCount,
            lateCount,
            onTimeRatePct: assessed === 0 ? null : Math.round((onTimeCount / assessed) * 100),
          },
        },
        // Already ordered by count desc from SQL.
        failureReasons: failureReasonCounts,
        checklists: {
          completed: checklistsCompleted,
          withFailures: checklistsWithFailures,
        },
        workshop: { openJobs: openWorkshopJobs },
        byOperator: [...byOperator.values()].sort((a, b) => b.delivered - a.delivered),
        cost: {
          totalCost,
          jobsWithCost,
          averageCostPerJob: jobsWithCost === 0 ? null : round2(totalCost / jobsWithCost),
          trend: [...costByDay.entries()].map(([date, cost]) => ({ date, cost })),
        },
        uptime: {
          fleetUptimePct,
          totalAssets,
          assetsWithDowntime,
        },
      };
    });
  }

  /**
   * The "how beneficial has FleetOS been" read-model: a month-by-month time
   * series plus headline totals, framed as the value the platform has delivered
   * — deliveries proven, service quality (on-time), safety compliance
   * (pre-start checks digitised), and workshop cost tracked. Pure computation
   * over existing rows, nothing stored. Feeds FleetHQ's Impact page.
   */
  async impact(companyId: string, query: ImpactReportDto) {
    const months = query.months ?? DEFAULT_IMPACT_MONTHS;
    const now = new Date();
    const to = endOfMonth(now);
    const from = startOfMonth(addMonths(now, -(months - 1)));
    const buckets = eachMonth(from, to);

    return this.prisma.withTenant(companyId, async (tx) => {
      // Monthly aggregates in SQL (date_trunc → 'YYYY-MM'). `completed_at` /
      // `submitted_at` are UTC-naive timestamps, so the truncated month matches
      // the JS monthKey used to zero-fill the buckets below.
      const [stopRows, checklistMonthRows, costRows, firstStop, firstSubmission, activeOperators, activeAssets] = await Promise.all([
        tx.$queryRaw<{ month_key: string; delivered: bigint; failed: bigint; on_time_assessed: bigint; on_time: bigint }[]>`
          SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS month_key,
            count(*) FILTER (WHERE outcome = 'DELIVERED') AS delivered,
            count(*) FILTER (WHERE outcome = 'FAILED') AS failed,
            count(*) FILTER (WHERE outcome = 'DELIVERED' AND window_end IS NOT NULL) AS on_time_assessed,
            count(*) FILTER (WHERE outcome = 'DELIVERED' AND window_end IS NOT NULL AND completed_at <= window_end) AS on_time
          FROM job_stops
          WHERE completed_at >= ${from} AND completed_at <= ${to} AND outcome IN ('DELIVERED', 'FAILED')
          GROUP BY 1
        `,
        tx.$queryRaw<{ month_key: string; total: bigint; clean: bigint }[]>`
          SELECT to_char(date_trunc('month', submitted_at), 'YYYY-MM') AS month_key,
            count(*) AS total,
            count(*) FILTER (WHERE NOT has_failures) AS clean
          FROM checklist_submissions
          WHERE submitted_at >= ${from} AND submitted_at <= ${to}
          GROUP BY 1
        `,
        tx.$queryRaw<{ month_key: string; cost: number; jobs: bigint }[]>`
          SELECT to_char(date_trunc('month', completed_at), 'YYYY-MM') AS month_key,
            coalesce(sum(coalesce(parts_cost, 0) + coalesce(labor_cost, 0)), 0)::float8 AS cost,
            count(*) AS jobs
          FROM maintenance_jobs
          WHERE completed_at >= ${from} AND completed_at <= ${to}
          GROUP BY 1
        `,
        tx.jobStop.findFirst({ where: { completedAt: { not: null } }, orderBy: { completedAt: 'asc' }, select: { completedAt: true } }),
        tx.checklistSubmission.findFirst({ orderBy: { submittedAt: 'asc' }, select: { submittedAt: true } }),
        tx.operator.count({ where: { archivedAt: null } }),
        tx.asset.count({ where: { archivedAt: null } }),
      ]);

      // One accumulator per calendar month, zero-filled so a quiet month still
      // appears in the series rather than vanishing.
      const empty = () => ({ delivered: 0, failed: 0, onTimeAssessed: 0, onTime: 0, checklists: 0, clean: 0, maintenanceCost: 0 });
      const byMonth = new Map(buckets.map((b) => [b.key, empty()]));

      for (const r of stopRows) {
        const m = byMonth.get(r.month_key);
        if (!m) continue;
        m.delivered += Number(r.delivered);
        m.failed += Number(r.failed);
        m.onTimeAssessed += Number(r.on_time_assessed);
        m.onTime += Number(r.on_time);
      }
      for (const r of checklistMonthRows) {
        const m = byMonth.get(r.month_key);
        if (!m) continue;
        m.checklists += Number(r.total);
        m.clean += Number(r.clean);
      }
      for (const r of costRows) {
        const m = byMonth.get(r.month_key);
        if (m) m.maintenanceCost = round2(m.maintenanceCost + r.cost);
      }

      const series = buckets.map((b) => {
        const m = byMonth.get(b.key)!;
        const stopsTotal = m.delivered + m.failed;
        return {
          month: b.key,
          label: b.label,
          delivered: m.delivered,
          failed: m.failed,
          deliveryRatePct: stopsTotal === 0 ? null : Math.round((m.delivered / stopsTotal) * 100),
          onTimeRatePct: m.onTimeAssessed === 0 ? null : Math.round((m.onTime / m.onTimeAssessed) * 100),
          checklists: m.checklists,
          maintenanceCost: m.maintenanceCost,
        };
      });

      // Headline totals across the whole window.
      const totalDelivered = series.reduce((s, m) => s + m.delivered, 0);
      const totalFailed = series.reduce((s, m) => s + m.failed, 0);
      const totalStops = totalDelivered + totalFailed;
      const totalChecklists = series.reduce((s, m) => s + m.checklists, 0);
      const cleanChecklists = [...byMonth.values()].reduce((s, m) => s + m.clean, 0);
      const totalMaintenanceCost = round2(series.reduce((s, m) => s + m.maintenanceCost, 0));
      const faultsTrackedToClosure = costRows.reduce((s, r) => s + Number(r.jobs), 0);
      const onTimeAssessed = [...byMonth.values()].reduce((s, m) => s + m.onTimeAssessed, 0);
      const onTimeMet = [...byMonth.values()].reduce((s, m) => s + m.onTime, 0);

      const firstActivityCandidates = [firstStop?.completedAt, firstSubmission?.submittedAt].filter((d): d is Date => !!d);
      const firstActivityAt = firstActivityCandidates.length
        ? new Date(Math.min(...firstActivityCandidates.map((d) => d.getTime())))
        : null;

      return {
        range: { from, to, months },
        firstActivityAt,
        headline: {
          deliveriesProven: totalDelivered,
          deliveryRatePct: totalStops === 0 ? null : Math.round((totalDelivered / totalStops) * 100),
          onTimeRatePct: onTimeAssessed === 0 ? null : Math.round((onTimeMet / onTimeAssessed) * 100),
          checklistsCompleted: totalChecklists,
          checklistPassRatePct: totalChecklists === 0 ? null : Math.round((cleanChecklists / totalChecklists) * 100),
          faultsTrackedToClosure,
          maintenanceCostTracked: totalMaintenanceCost,
          activeOperators,
          activeAssets,
          failedDeliveries: totalFailed,
        },
        series,
      };
    });
  }
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function endOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}
function addDays(d: Date, days: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + days);
  return c;
}
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function eachDay(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cur = startOfDay(from);
  const last = startOfDay(to);
  while (cur.getTime() <= last.getTime()) {
    days.push(dayKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function eachMonth(from: Date, to: Date): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const cur = startOfMonth(from);
  const last = startOfMonth(to);
  while (cur.getTime() <= last.getTime()) {
    out.push({ key: monthKey(cur), label: cur.toLocaleString('en-AU', { month: 'short', year: '2-digit' }) });
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}
