import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JobStatus, Prisma, StopOutcome, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomersService } from '../customers/customers.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import {
  describeImportRowError,
  flattenValidationErrors,
  summarizeImportRows,
  type ImportResult,
  type ImportRowResult,
} from '../common/imports/import-helpers';
import { ImportRowsDto } from '../imports/dto/import-rows.dto';
import { AddStopsDto } from './dto/add-stops.dto';
import { CompleteStopDto } from './dto/complete-stop.dto';
import { ImportStopRowDto } from './dto/import-stop-row.dto';
import { ReorderStopsDto } from './dto/reorder-stops.dto';
import { ReattemptStopDto } from './dto/reattempt-stop.dto';
import { JOB_INCLUDE, JobsSupportService } from './jobs.support';
import { FormsService } from '../forms/forms.service';

/** How far back a client-supplied delivery time is trusted. A DriverOS entry
 *  that syncs after a long dead-zone run is legitimately hours old; anything
 *  older than this is treated as a bad clock and falls back to server time. */
const MAX_OCCURRED_AT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Resolve the completion time from an optional, untrusted client timestamp.
 * Honours the real delivery time for offline replays, but never trusts it
 * blindly: a future time (a device clock running fast) or an implausibly old
 * one falls back to now, so a bad clock can't corrupt on-time reporting.
 */
function resolveOccurredAt(occurredAt: string | undefined): Date {
  const now = new Date();
  if (!occurredAt) return now;
  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.getTime())) return now;
  if (parsed.getTime() > now.getTime()) return now;
  if (now.getTime() - parsed.getTime() > MAX_OCCURRED_AT_AGE_MS) return now;
  return parsed;
}

/**
 * Delivery-stop operations for the courier vertical
 * (00-Company/Commercial_Priority.md) — reattempt, bulk/one-off add, manifest
 * import, manual reorder, and completion with Proof of Delivery. Split out of
 * `JobsService` so job-lifecycle and stop-manipulation are separate concerns;
 * the two share low-level helpers (job lookup, terminal guard, operator
 * notification, OPERATED relationship) via `JobsSupportService` rather than
 * duplicating them.
 */
@Injectable()
export class JobStopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly attachments: AttachmentsService,
    private readonly notifications: NotificationsService,
    private readonly customers: CustomersService,
    private readonly support: JobsSupportService,
    private readonly forms: FormsService,
  ) {}

  /**
   * Reattempt a failed delivery: "Repeat a run" duplicates a whole job, but
   * there was no way to redeliver just ONE failed stop. Creates a fresh PENDING
   * stop carrying the same customer/address, tagged `reattemptOfStopId` so the
   * office can trace a delivery's full attempt history even across separate
   * jobs. The original stop stays exactly as recorded (FAILED, with its own
   * note/reason) — this never mutates history, only adds a new attempt.
   */
  async reattemptStop(companyId: string, actorUserId: string, jobId: string, stopId: string, dto: ReattemptStopDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await this.support.requireJob(tx, companyId, jobId);
      const stop = await tx.jobStop.findUnique({ where: { id: stopId } });
      if (!stop || stop.companyId !== companyId || stop.jobId !== jobId) {
        throw new NotFoundException({ code: 'JOB_STOP_NOT_FOUND', message: 'Delivery stop not found.' });
      }
      if (stop.outcome !== StopOutcome.FAILED) {
        throw new ConflictException({ code: 'STOP_NOT_FAILED', message: 'Only a failed stop can be reattempted.' });
      }

      let targetJobId: string;
      if (dto.targetJobId) {
        const targetJob = await this.support.requireJob(tx, companyId, dto.targetJobId);
        this.support.assertNotTerminal(targetJob);
        targetJobId = targetJob.id;
      } else {
        targetJobId = await this.createRedeliveryJob(tx, companyId, actorUserId, job);
      }

      const last = await tx.jobStop.aggregate({ where: { jobId: targetJobId }, _max: { sequence: true } });
      const nextSeq = (last._max.sequence ?? 0) + 1;

      const newStop = await tx.jobStop.create({
        data: {
          companyId,
          jobId: targetJobId,
          customerId: stop.customerId ?? undefined,
          sequence: nextSeq,
          label: stop.label,
          address: stop.address,
          contactName: stop.contactName,
          reattemptOfStopId: stop.id,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: targetJobId,
        eventType: 'stop_reattempt_created',
        summary: `Redelivery stop created for "${stop.label}".`,
        payload: { reattemptOfStopId: stop.id, originalJobId: jobId, newStopId: newStop.id },
        actorUserId,
      });

      return tx.job.findUnique({ where: { id: targetJobId }, include: JOB_INCLUDE });
    });
  }

  /**
   * Spin up a fresh job for a redelivery, carrying over the original job's
   * asset/operator only if each is still active (same safety rule `duplicate()`
   * uses). Returns the new job's id.
   */
  private async createRedeliveryJob(
    tx: Prisma.TransactionClient,
    companyId: string,
    actorUserId: string,
    sourceJob: { title: string; assetId: string | null; operatorId: string | null },
  ): Promise<string> {
    let assetId: string | undefined;
    if (sourceJob.assetId) {
      const asset = await tx.asset.findUnique({ where: { id: sourceJob.assetId } });
      if (asset && !asset.archivedAt) assetId = asset.id;
    }
    let operatorId: string | undefined;
    if (sourceJob.operatorId) {
      const operator = await tx.operator.findUnique({ where: { id: sourceJob.operatorId } });
      if (operator && !operator.archivedAt) operatorId = operator.id;
    }

    const newJob = await tx.job.create({
      data: {
        companyId,
        title: `${sourceJob.title} — redelivery`,
        assetId,
        operatorId,
        status: assetId || operatorId ? JobStatus.ASSIGNED : JobStatus.UNASSIGNED,
      },
    });
    if (assetId && operatorId) {
      await this.support.openOperatedRelationship(tx, companyId, operatorId, assetId);
    }
    await this.timeline.record(tx, {
      companyId,
      entityType: TimelineEntityType.JOB,
      entityId: newJob.id,
      eventType: 'created',
      summary: `Job "${newJob.title}" created for a redelivery attempt.`,
      actorUserId,
    });
    if (operatorId) {
      await this.support.notifyAssignedOperator(tx, companyId, operatorId, newJob.title);
    }
    return newJob.id;
  }

  async addStops(companyId: string, actorUserId: string, jobId: string, dto: AddStopsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await this.support.requireJob(tx, companyId, jobId);
      this.support.assertNotTerminal(job);

      const last = await tx.jobStop.aggregate({ where: { jobId }, _max: { sequence: true } });
      let seq = last._max.sequence ?? 0;

      for (const stop of dto.stops) {
        // A Customer supplies the defaults; any explicit field still wins so a
        // one-off alternate address for that customer isn't blocked.
        let customer: { id: string; name: string; address: string | null; contactName: string | null } | null = null;
        if (stop.customerId) {
          customer = await this.customers.requireCustomer(tx, companyId, stop.customerId);
        }
        const label = stop.label ?? customer?.name;
        if (!label) {
          throw new BadRequestException({
            code: 'STOP_LABEL_REQUIRED',
            message: 'Each stop needs a label or a customer to derive one from.',
          });
        }

        seq += 1;
        await tx.jobStop.create({
          data: {
            companyId,
            jobId,
            customerId: customer?.id,
            sequence: seq,
            label,
            address: stop.address ?? customer?.address ?? undefined,
            contactName: stop.contactName ?? customer?.contactName ?? undefined,
            windowStart: stop.windowStart ? new Date(stop.windowStart) : undefined,
            windowEnd: stop.windowEnd ? new Date(stop.windowEnd) : undefined,
          },
        });
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: jobId,
        eventType: 'stops_added',
        summary: `${dto.stops.length} stop(s) added to "${job.title}".`,
        actorUserId,
      });

      return tx.job.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
    });
  }

  /**
   * Bulk manifest import for one job's delivery run: a dispatcher uploads a CSV
   * of stops instead of adding 40 rows one at a time. Follows the same
   * dry-run/commit shape as Assets/Operators import (01-Product/Onboarding_Import.md)
   * — a bad row never blocks the rows around it — but reuses `addStops` per row
   * rather than duplicating its label-defaulting/validation logic.
   */
  async importStops(companyId: string, actorUserId: string, jobId: string, dto: ImportRowsDto): Promise<ImportResult> {
    const job = await this.prisma.withTenant(companyId, (tx) => this.support.requireJob(tx, companyId, jobId));
    this.support.assertNotTerminal(job);

    const dryRun = dto.dryRun ?? false;
    const rows: ImportRowResult[] = [];

    for (let index = 0; index < dto.rows.length; index++) {
      const instance = plainToInstance(ImportStopRowDto, dto.rows[index]);
      const errors = await validate(instance);
      if (errors.length > 0) {
        rows.push({ index, valid: false, created: false, errors: flattenValidationErrors(errors) });
        continue;
      }
      if (!instance.label?.trim() && !instance.customerName?.trim()) {
        rows.push({ index, valid: false, created: false, errors: ['Provide a label or a customer name.'] });
        continue;
      }
      if (dryRun) {
        rows.push({ index, valid: true, created: false, errors: [] });
        continue;
      }
      rows.push(await this.importOneStopRow(companyId, actorUserId, jobId, index, instance));
    }

    return summarizeImportRows(dto.rows.length, dryRun, rows);
  }

  /** Commit a single validated manifest row: resolve/create its Customer, then add the stop. */
  private async importOneStopRow(
    companyId: string,
    actorUserId: string,
    jobId: string,
    index: number,
    instance: ImportStopRowDto,
  ): Promise<ImportRowResult> {
    try {
      let customerId: string | undefined;
      if (instance.customerName?.trim()) {
        const customer = await this.customers.findOrCreateByName(
          companyId,
          actorUserId,
          instance.customerName.trim(),
          instance.address,
          instance.contactName,
        );
        customerId = customer.id;
      }
      const updatedJob = await this.addStops(companyId, actorUserId, jobId, {
        stops: [{ customerId, label: instance.label, address: instance.address, contactName: instance.contactName }],
      });
      const createdStop = updatedJob!.stops[updatedJob!.stops.length - 1];
      return { index, valid: true, created: true, errors: [], id: createdStop.id };
    } catch (err) {
      return { index, valid: false, created: false, errors: [describeImportRowError(err)] };
    }
  }

  /**
   * Manual stop reordering — a dispatcher fixing a mistake or resequencing the
   * day, NOT route optimization (still deferred). Only PENDING stops move; a
   * completed/failed stop's sequence is factual history and keeps its exact
   * slot. Reassigns the SAME set of sequence numbers currently held by the
   * pending stops (sorted ascending) to the caller's new ordering, so completed
   * stops interleaved between pending ones never shift.
   */
  async reorderStops(companyId: string, actorUserId: string, jobId: string, dto: ReorderStopsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await this.support.requireJob(tx, companyId, jobId);
      this.support.assertNotTerminal(job);

      const pendingStops = await tx.jobStop.findMany({
        where: { jobId, outcome: StopOutcome.PENDING },
        orderBy: { sequence: 'asc' },
      });
      const pendingIds = new Set(pendingStops.map((s) => s.id));
      const providedIds = dto.stopIds;

      const isValidSet =
        providedIds.length === pendingStops.length &&
        new Set(providedIds).size === providedIds.length &&
        providedIds.every((id) => pendingIds.has(id));
      if (!isValidSet) {
        throw new BadRequestException({
          code: 'STOP_REORDER_MISMATCH',
          message: "Provide exactly the job's pending stops, each once.",
        });
      }

      const availableSlots = pendingStops.map((s) => s.sequence).sort((a, b) => a - b);
      for (let i = 0; i < providedIds.length; i++) {
        await tx.jobStop.update({ where: { id: providedIds[i] }, data: { sequence: availableSlots[i] } });
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: jobId,
        eventType: 'stops_reordered',
        summary: `Stops reordered on "${job.title}".`,
        actorUserId,
      });

      return tx.job.findUnique({ where: { id: jobId }, include: JOB_INCLUDE });
    });
  }

  async completeStop(companyId: string, actorUserId: string, jobId: string, stopId: string, dto: CompleteStopDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await this.support.requireJob(tx, companyId, jobId);
      const stop = await tx.jobStop.findUnique({ where: { id: stopId } });
      if (!stop || stop.companyId !== companyId || stop.jobId !== jobId) {
        throw new NotFoundException({ code: 'JOB_STOP_NOT_FOUND', message: 'Delivery stop not found.' });
      }

      // Idempotent for offline replay: a stop already recorded with the same
      // outcome is returned untouched rather than double-completed.
      if (stop.outcome !== StopOutcome.PENDING) {
        if (stop.outcome === dto.outcome) {
          return { stop, job: await tx.job.findUnique({ where: { id: jobId }, include: JOB_INCLUDE }), replayed: true };
        }
        throw new ConflictException({ code: 'JOB_STOP_ALREADY_COMPLETED', message: 'This stop is already completed.' });
      }

      if (dto.failureReason && dto.outcome !== 'FAILED') {
        throw new BadRequestException({
          code: 'FAILURE_REASON_REQUIRES_FAILED',
          message: 'A failure reason only makes sense on a FAILED outcome.',
        });
      }

      // Configurable POD (docs/design/Configurable_POD.md): if the tenant has an
      // active DELIVERY form template, a confirmed drop MUST carry evidence
      // satisfying it — validated server-side (a missing required photo is
      // rejected here, not just hidden in a client UI). The one submission is
      // shared across the stop's parcels. No DELIVERY template → legacy
      // podPhotoBase64/signatureBase64 path, unchanged.
      const podTemplate =
        dto.outcome === StopOutcome.DELIVERED ? await this.forms.findActiveDeliveryTemplate(tx, companyId) : null;
      let podSubmissionId: string | undefined;
      if (podTemplate) {
        if (!dto.evidence) {
          throw new BadRequestException({
            code: 'POD_EVIDENCE_REQUIRED',
            message: `Proof of delivery is required: complete the "${podTemplate.name}" form.`,
          });
        }
        const submission = await this.forms.createDeliverySubmissionInTx(
          tx,
          companyId,
          actorUserId,
          podTemplate,
          dto.evidence.answers,
          dto.evidence.id,
        );
        podSubmissionId = submission.id;
      }

      const completedAt = resolveOccurredAt(dto.occurredAt);

      const podAttachmentId = await this.storeStopProof(
        tx,
        companyId,
        actorUserId,
        dto.podPhotoBase64,
        dto.podPhotoFilename ?? 'proof-of-delivery.jpg',
        dto.podPhotoContentType ?? 'image/jpeg',
      );
      const signatureAttachmentId = await this.storeStopProof(
        tx,
        companyId,
        actorUserId,
        dto.signatureBase64,
        dto.signatureFilename ?? 'signature.png',
        dto.signatureContentType ?? 'image/png',
      );

      const updatedStop = await tx.jobStop.update({
        where: { id: stopId },
        data: {
          outcome: dto.outcome as StopOutcome,
          completedAt,
          recipientName: dto.recipientName,
          note: dto.note,
          failureReason: dto.failureReason,
          podAttachmentId,
          signatureAttachmentId,
          podSubmissionId,
        },
      });

      // Multi-drop: mark each covered parcel individually delivered, sharing the
      // one evidence submission. Only on a DELIVERED outcome — a failed stop
      // delivers nothing.
      if (dto.outcome === StopOutcome.DELIVERED) {
        await this.markParcelsDelivered(tx, stopId, dto.parcelIds, completedAt, podSubmissionId);
        // Never SILENTLY deliver an unscanned parcel: record any covered parcel
        // that went out without being scanned/confirmed, the same override-and-
        // record contract the pre-run load verification uses.
        await this.recordUnconfirmedParcelOverride(tx, companyId, actorUserId, job, stopId, stop.label, dto.parcelIds, completedAt);
      }

      await this.recordStopCompletion(
        tx,
        companyId,
        actorUserId,
        job,
        stopId,
        stop,
        dto,
        !!podAttachmentId || !!podSubmissionId,
      );

      // Roll the job up to COMPLETED once every stop is terminal.
      const remaining = await tx.jobStop.count({ where: { jobId, outcome: StopOutcome.PENDING } });
      let jobCompleted = false;
      if (remaining === 0 && job.status !== JobStatus.COMPLETED && job.status !== JobStatus.CANCELLED) {
        await this.rollUpJobToCompleted(tx, companyId, actorUserId, job);
        jobCompleted = true;
      }

      return {
        stop: updatedStop,
        job: await tx.job.findUnique({ where: { id: jobId }, include: JOB_INCLUDE }),
        replayed: false,
        jobCompleted,
      };
    });
  }

  /** Persist an optional POD photo / signature and return its attachment id. */
  private async storeStopProof(
    tx: Prisma.TransactionClient,
    companyId: string,
    actorUserId: string,
    dataBase64: string | undefined,
    filename: string,
    contentType: string,
  ): Promise<string | undefined> {
    if (!dataBase64) return undefined;
    const att = await this.attachments.createInTx(tx, companyId, actorUserId, { filename, contentType, dataBase64 });
    return att.id;
  }

  /**
   * Multi-drop (docs/design/Configurable_POD.md): mark the covered parcels of a
   * stop delivered, each stamped with its own `deliveredAt` while sharing the
   * one POD submission. `parcelIds` restricts the set (validated to belong to
   * the stop); omitted → every parcel at the stop. Already-delivered parcels are
   * left untouched (idempotent replay). A stop with no parcels is a no-op — the
   * stop-level completion already recorded the delivery.
   */
  private async markParcelsDelivered(
    tx: Prisma.TransactionClient,
    stopId: string,
    parcelIds: string[] | undefined,
    deliveredAt: Date,
    podSubmissionId: string | undefined,
  ) {
    const parcels = await tx.stopParcel.findMany({ where: { stopId }, select: { id: true } });
    if (parcels.length === 0) return;

    const stopParcelIds = new Set(parcels.map((p) => p.id));
    let targetIds: string[];
    if (parcelIds && parcelIds.length > 0) {
      for (const id of parcelIds) {
        if (!stopParcelIds.has(id)) {
          throw new BadRequestException({
            code: 'POD_PARCEL_NOT_ON_STOP',
            message: 'A parcel id in this confirmation does not belong to the stop.',
          });
        }
      }
      targetIds = parcelIds;
    } else {
      targetIds = [...stopParcelIds];
    }

    await tx.stopParcel.updateMany({
      where: { id: { in: targetIds }, deliveredAt: null },
      data: { deliveredAt, podSubmissionId: podSubmissionId ?? null },
    });
  }

  /**
   * Record — never silently allow — a delivery that covers parcels which were
   * never scanned/confirmed. The office gets a JOB timeline event naming WHO
   * overrode (actorUserId), WHEN (the completion time), and exactly WHICH
   * references went out unconfirmed — the same override-and-record contract the
   * pre-run load verification uses for its discrepancies. The unconfirmed set is
   * recomputed here from `StopParcel.scannedAt`, so the client can't spoof it. A
   * stop with no parcels, or where every covered parcel was scanned, records
   * nothing. (Deliberately additive, not a rejection: a stop can legitimately be
   * delivered without a scan — the requirement is that it's never *silent*.)
   */
  private async recordUnconfirmedParcelOverride(
    tx: Prisma.TransactionClient,
    companyId: string,
    actorUserId: string,
    job: { id: string; title: string },
    stopId: string,
    stopLabel: string,
    parcelIds: string[] | undefined,
    occurredAt: Date,
  ) {
    const parcels = await tx.stopParcel.findMany({
      where: { stopId },
      select: { id: true, reference: true, scannedAt: true },
    });
    if (parcels.length === 0) return; // no manifest → nothing to confirm against
    const covered = parcelIds && parcelIds.length > 0 ? parcels.filter((p) => parcelIds.includes(p.id)) : parcels;
    const unconfirmed = covered.filter((p) => !p.scannedAt);
    if (unconfirmed.length === 0) return;
    const references = unconfirmed.map((p) => p.reference);
    await this.timeline.record(tx, {
      companyId,
      entityType: TimelineEntityType.JOB,
      entityId: job.id,
      eventType: 'pod_unconfirmed_override',
      summary: `Stop "${stopLabel}" delivered with ${references.length} unscanned parcel(s) on "${job.title}".`,
      payload: { stopId, occurredAt: occurredAt.toISOString(), unconfirmedCount: references.length, unconfirmedReferences: references },
      actorUserId,
    });
  }

  /** Timeline (asset + job) and the failed-delivery office notification for a completed stop. */
  private async recordStopCompletion(
    tx: Prisma.TransactionClient,
    companyId: string,
    actorUserId: string,
    job: { id: string; title: string; assetId: string | null },
    stopId: string,
    stop: { label: string },
    dto: CompleteStopDto,
    hasPhoto: boolean,
  ) {
    const verb = dto.outcome === StopOutcome.DELIVERED ? 'delivered' : 'delivery failed';
    if (job.assetId) {
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ASSET,
        entityId: job.assetId,
        eventType: 'stop_completed',
        summary: `Stop "${stop.label}" ${verb}.`,
        payload: { jobId: job.id, stopId, outcome: dto.outcome, hasPhoto },
        actorUserId,
      });
    }
    await this.timeline.record(tx, {
      companyId,
      entityType: TimelineEntityType.JOB,
      entityId: job.id,
      eventType: 'stop_completed',
      summary: `Stop "${stop.label}" ${verb}.`,
      payload: { stopId, outcome: dto.outcome },
      actorUserId,
    });

    // A failed delivery needs office attention — notify everyone who watches Dispatch.
    if (dto.outcome === StopOutcome.FAILED) {
      await this.notifications.notifyPermissionInTx(
        tx,
        companyId,
        PERMISSIONS.DISPATCH_VIEW,
        {
          type: 'delivery_failed',
          title: `Delivery failed: ${stop.label}`,
          body: dto.note ?? `On job "${job.title}".`,
          linkPath: '/dispatch',
        },
        actorUserId,
      );
    }
  }

  /** Close the OPERATED relationship and flip the job to COMPLETED with a timeline event. */
  private async rollUpJobToCompleted(
    tx: Prisma.TransactionClient,
    companyId: string,
    actorUserId: string,
    job: { id: string; title: string; assetId: string | null; operatorId: string | null },
  ) {
    if (job.assetId && job.operatorId) {
      await this.support.closeOperatedRelationship(tx, companyId, job.operatorId, job.assetId);
    }
    await tx.job.update({ where: { id: job.id }, data: { status: JobStatus.COMPLETED, completedAt: new Date() } });
    await this.timeline.record(tx, {
      companyId,
      entityType: TimelineEntityType.JOB,
      entityId: job.id,
      eventType: 'completed',
      summary: `Job "${job.title}" completed — all stops done.`,
      actorUserId,
    });
  }
}
