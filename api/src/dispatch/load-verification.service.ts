import { ConflictException, Injectable } from '@nestjs/common';
import { TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { JobsSupportService } from './jobs.support';
import { LoadVerificationDto } from './dto/load-verification.dto';

/**
 * Load verification for a run (item 2): before a driver starts, they confirm
 * what's actually been loaded against the run's expected manifest. There is no
 * new "manifest" entity or second matcher — the manifest is the aggregate of a
 * job's stops' `StopParcel` rows, and "scanned/confirmed" is the existing
 * `StopParcel.scannedAt` set by the one scan path (`.../parcels/scan`). Manual
 * "mark loaded" reuses that same scan endpoint, so there is exactly one place
 * that flips a parcel to loaded.
 *
 * This service only (a) aggregates that state into a load status and (b) gates
 * the "proceed" decision: a clean load records a `load_verified` JOB timeline
 * event; a load with unscanned parcels is rejected unless the driver explicitly
 * overrides, in which case a `load_discrepancy_override` JOB timeline event
 * records who overrode, when, and exactly what was missing.
 */
@Injectable()
export class LoadVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly support: JobsSupportService,
  ) {}

  /** Aggregated expected load for a run: per-stop parcels + scanned state, totals, and the discrepancy list. */
  async getLoadStatus(companyId: string, jobId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await this.support.requireJob(tx, companyId, jobId);
      const stops = await tx.jobStop.findMany({
        where: { jobId },
        orderBy: { sequence: 'asc' },
        include: { parcels: { orderBy: { createdAt: 'asc' } } },
      });
      return this.buildStatus(job, stops);
    });
  }

  /**
   * Record the driver's load verification. Recomputes the discrepancy set from
   * the DB (never trusts the client for what's missing) and:
   *  - discrepancy + no override → reject with LOAD_DISCREPANCY (run can't start
   *    on a partial load unacknowledged);
   *  - discrepancy + override → record `load_discrepancy_override` (who/when/what
   *    was missing) and stamp `loadVerifiedAt`;
   *  - clean → record `load_verified` and stamp `loadVerifiedAt`.
   * Idempotent for offline replay: a job already verified is returned untouched
   * rather than recording a second event.
   */
  async verifyLoad(companyId: string, actorUserId: string, jobId: string, dto: LoadVerificationDto) {
    // SERIALIZABLE: this is a check-then-write on job.loadVerifiedAt. Two
    // concurrent confirmations on the same run (a driver double-tapping, or an
    // offline outbox replay racing a live tap) could both read loadVerifiedAt as
    // null under READ COMMITTED and each stamp the timeline — a double-recorded
    // verify/override. Under SERIALIZABLE, Postgres' SSI aborts one and
    // withTenantSerializable re-runs it, where the idempotency guard now sees
    // loadVerifiedAt set and returns the replayed no-op. Retry is bounded inside
    // withTenantSerializable (SQLSTATE 40001 → P2034), same as the other callers.
    return this.prisma.withTenantSerializable(companyId, async (tx) => {
      const job = await this.support.requireJob(tx, companyId, jobId);
      const stops = await tx.jobStop.findMany({
        where: { jobId },
        orderBy: { sequence: 'asc' },
        include: { parcels: { orderBy: { createdAt: 'asc' } } },
      });
      const status = this.buildStatus(job, stops);

      // Already verified — a replayed/duplicate confirmation is an idempotent
      // no-op, so an offline outbox replay can't stamp a second timeline event.
      if (job.loadVerifiedAt) {
        return { ...status, verified: true, replayed: true };
      }

      const missingReferences = status.discrepancies.map((d) => d.reference);

      if (status.discrepancies.length > 0 && !dto.override) {
        // Hard stop: the run can't proceed on a partial load without an explicit
        // override. The client gets the missing set so it can show it and offer
        // "Proceed anyway".
        throw new ConflictException({
          code: 'LOAD_DISCREPANCY',
          message: 'Some manifest parcels have not been scanned or confirmed as loaded.',
          expectedTotal: status.expectedTotal,
          scannedTotal: status.scannedTotal,
          missingReferences,
        });
      }

      const now = new Date();
      await tx.job.update({ where: { id: jobId }, data: { loadVerifiedAt: now } });

      if (status.discrepancies.length > 0) {
        // Override: capture WHO (actorUserId), WHEN (the event time), and WHAT
        // WAS MISSING (the server-computed missing references).
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.JOB,
          entityId: jobId,
          eventType: 'load_discrepancy_override',
          summary: `Load verified with ${missingReferences.length} unconfirmed parcel(s) overridden on "${job.title}".`,
          payload: {
            expectedTotal: status.expectedTotal,
            scannedTotal: status.scannedTotal,
            missingCount: missingReferences.length,
            missingReferences,
            discrepancies: status.discrepancies,
          },
          actorUserId,
        });
      } else {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.JOB,
          entityId: jobId,
          eventType: 'load_verified',
          summary: `Load verified for "${job.title}" — all ${status.expectedTotal} parcel(s) confirmed.`,
          payload: { expectedTotal: status.expectedTotal, scannedTotal: status.scannedTotal },
          actorUserId,
        });
      }

      return { ...this.buildStatus({ ...job, loadVerifiedAt: now }, stops), verified: true, replayed: false };
    });
  }

  private buildStatus(
    job: { id: string; loadVerifiedAt: Date | null },
    stops: Array<{
      id: string;
      label: string;
      parcels: Array<{ id: string; reference: string; scannedAt: Date | null }>;
    }>,
  ) {
    const stopStatuses = stops.map((s) => {
      const parcels = s.parcels.map((p) => ({ id: p.id, reference: p.reference, scannedAt: p.scannedAt }));
      return {
        stopId: s.id,
        label: s.label,
        parcels,
        scannedCount: parcels.filter((p) => p.scannedAt).length,
        expectedCount: parcels.length,
      };
    });
    const discrepancies: Array<{ stopId: string; stopLabel: string; parcelId: string; reference: string }> = [];
    for (const s of stops) {
      for (const p of s.parcels) {
        if (!p.scannedAt) {
          discrepancies.push({ stopId: s.id, stopLabel: s.label, parcelId: p.id, reference: p.reference });
        }
      }
    }
    const expectedTotal = stopStatuses.reduce((n, s) => n + s.expectedCount, 0);
    const scannedTotal = stopStatuses.reduce((n, s) => n + s.scannedCount, 0);
    return {
      jobId: job.id,
      stops: stopStatuses,
      expectedTotal,
      scannedTotal,
      discrepancies,
      loadVerifiedAt: job.loadVerifiedAt,
    };
  }
}
