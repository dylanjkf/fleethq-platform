import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportLocationDto } from './dto/report-location.dto';

/**
 * Live operator location (05-Dispatch/Dispatch_Overview.md's "where is my
 * driver right now"): a DriverOS device reports its position while on shift,
 * and the office dispatch board reads the fleet's last-known positions.
 *
 * Deliberately lightweight: only the *latest* fix is kept, stored right on the
 * Operator row — this is live telemetry, not a breadcrumb trail, and not a
 * meaningful business event, so it does not write a Timeline entry (which would
 * otherwise be spammed with a position every minute). A future route-history
 * feature would add its own append-only table; this one answers "where now".
 */
@Injectable()
export class LocationsService {
  // Positions older than this are treated as "not currently on the road" and
  // excluded from the live board — a fix from a shift two days ago isn't "live".
  private static readonly LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;

  constructor(private readonly prisma: PrismaService) {}

  async report(companyId: string, actorUserId: string, dto: ReportLocationDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operator = await tx.operator.findFirst({ where: { userId: actorUserId, archivedAt: null } });
      if (!operator) {
        throw new ConflictException({
          code: 'LOCATION_OPERATOR_REQUIRED',
          message: 'Only a linked Operator login can report a location.',
        });
      }
      // accuracyM is accepted for forward compatibility (a future breadcrumb
      // table would keep it) but isn't persisted on the latest-only row.
      await tx.operator.update({
        where: { id: operator.id },
        data: { lastLat: dto.lat, lastLng: dto.lng, lastLocationAt: new Date() },
      });
      return { ok: true };
    });
  }

  /**
   * The fleet's last-known positions, most-recently-seen first — enriched with
   * each operator's active-job unit (which truck they're in) and whether
   * they're currently on shift, so the dedicated live map can label markers by
   * road unit, not just driver name.
   */
  async currentFleet(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const since = new Date(Date.now() - LocationsService.LIVE_WINDOW_MS);
      const operators = await tx.operator.findMany({
        where: {
          archivedAt: null,
          lastLocationAt: { gte: since },
          lastLat: { not: null },
          lastLng: { not: null },
        },
        select: { id: true, fullName: true, lastLat: true, lastLng: true, lastLocationAt: true },
        orderBy: { lastLocationAt: 'desc' },
      } satisfies Prisma.OperatorFindManyArgs);

      const operatorIds = operators.map((o) => o.id);
      const [assignedJobs, activeShifts] = operatorIds.length
        ? await Promise.all([
            tx.job.findMany({
              where: { operatorId: { in: operatorIds }, status: 'ASSIGNED' },
              select: {
                id: true,
                title: true,
                operatorId: true,
                asset: { select: { id: true, name: true } },
              },
              orderBy: { scheduledAt: 'asc' },
            }),
            tx.operatorShift.findMany({
              where: { operatorId: { in: operatorIds }, status: 'ACTIVE' },
              select: { operatorId: true },
            }),
          ])
        : [[], []];

      // First (soonest-scheduled) assigned job per operator wins the label.
      const jobByOperator = new Map<string, (typeof assignedJobs)[number]>();
      for (const job of assignedJobs) {
        if (job.operatorId && !jobByOperator.has(job.operatorId)) jobByOperator.set(job.operatorId, job);
      }
      const onShift = new Set(activeShifts.map((s) => s.operatorId));

      return {
        items: operators.map((o) => {
          const job = jobByOperator.get(o.id);
          return {
            operatorId: o.id,
            fullName: o.fullName,
            lat: o.lastLat,
            lng: o.lastLng,
            lastLocationAt: o.lastLocationAt,
            onShift: onShift.has(o.id),
            activeJob: job ? { id: job.id, title: job.title } : null,
            unit: job?.asset ? { id: job.asset.id, name: job.asset.name } : null,
          };
        }),
      };
    });
  }
}
