import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { JobStatus, Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { DepotsService } from '../depots/depots.service';
import { AssetsService } from '../assets/assets.service';
import { OperatorsService } from '../operators/operators.service';
import { FatigueService } from '../compliance/fatigue.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  describeImportRowError,
  flattenValidationErrors,
  summarizeImportRows,
  type ImportResult,
  type ImportRowResult,
} from '../common/imports/import-helpers';
import { ImportRowsDto } from '../imports/dto/import-rows.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { DuplicateJobDto } from './dto/duplicate-job.dto';
import { UpdateJobDto } from './dto/update-job.dto';
import { AssignJobDto } from './dto/assign-job.dto';
import { ListJobsDto } from './dto/list-jobs.dto';
import { JOB_INCLUDE, JobsSupportService } from './jobs.support';

/**
 * The Dispatch milestone's job-lifecycle slice (05-Dispatch/Dispatch_Overview.md):
 * job creation, assignment to an Asset/Operator, and status transitions. Every
 * assignment change that results in a job having both an Asset and an Operator
 * writes a timed `OPERATED` GraphRelationship (see `JobsSupportService`).
 *
 * Delivery-stop operations (add/import/reorder/reattempt/complete-with-POD) live
 * in `JobStopsService`; the two share job lookup, the terminal-state guard,
 * operator notification, and the OPERATED relationship via `JobsSupportService`.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly depots: DepotsService,
    private readonly assets: AssetsService,
    private readonly operators: OperatorsService,
    private readonly fatigue: FatigueService,
    private readonly support: JobsSupportService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateJobDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.assetId) await this.assets.requireAsset(tx, companyId, dto.assetId, { allowArchived: false });
      if (dto.operatorId) await this.operators.requireOperator(tx, companyId, dto.operatorId, { allowArchived: false });
      if (dto.pickupDepotId) await this.depots.requireDepot(tx, companyId, dto.pickupDepotId);

      const status = dto.assetId || dto.operatorId ? JobStatus.ASSIGNED : JobStatus.UNASSIGNED;

      const job = await tx.job.create({
        data: {
          companyId,
          title: dto.title,
          description: dto.description,
          assetId: dto.assetId,
          operatorId: dto.operatorId,
          pickupDepotId: dto.pickupDepotId,
          status,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        },
      });

      if (job.assetId && job.operatorId) {
        await this.support.openOperatedRelationship(tx, companyId, job.operatorId, job.assetId);
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: job.id,
        eventType: 'created',
        summary: `Job "${job.title}" created.`,
        actorUserId,
      });

      if (job.operatorId) {
        await this.support.notifyAssignedOperator(tx, companyId, job.operatorId, job.title);
      }

      return job;
    });
  }

  /**
   * Create many jobs in one action — the courier dispatcher planning a whole
   * day/week of runs at once instead of opening the dialog N times. Each row is
   * validated with the ordinary CreateJobDto and created through the same
   * `create()` path, so a bulk-created job is identical to a hand-created one
   * (timeline event, OPERATED relationship, operator notification, scheduledAt).
   * Per-row independence, like every other bulk path: one bad row reports its
   * own error and every other row is still created. No new permission — gated on
   * the existing dispatch:create.
   */
  async bulkCreate(companyId: string, actorUserId: string, dto: ImportRowsDto): Promise<ImportResult> {
    const dryRun = dto.dryRun ?? false;
    const rows: ImportRowResult[] = [];
    for (let index = 0; index < dto.rows.length; index++) {
      const instance = plainToInstance(CreateJobDto, dto.rows[index]);
      const errors = await validate(instance as object);
      if (errors.length > 0) {
        rows.push({ index, valid: false, created: false, errors: flattenValidationErrors(errors) });
        continue;
      }
      if (dryRun) {
        rows.push({ index, valid: true, created: false, errors: [] });
        continue;
      }
      try {
        const job = await this.create(companyId, actorUserId, instance);
        rows.push({ index, valid: true, created: true, errors: [], id: job.id });
      } catch (err) {
        rows.push({ index, valid: false, created: false, errors: [describeImportRowError(err)] });
      }
    }
    return summarizeImportRows(dto.rows.length, dryRun, rows);
  }

  /**
   * "Repeat a run" (courier vertical, 00-Company/Commercial_Priority.md):
   * courier routes are usually the same handful of stops every day, so
   * duplicating an existing job's stops into a fresh one for today/tomorrow is
   * a one-click alternative to re-entering the whole manifest. Copies the
   * asset/operator ONLY if each is still active — a resource archived since the
   * original run silently drops rather than assigning a duplicate to something
   * gone, leaving the new job unassigned instead. Every stop is copied with a
   * clean PENDING outcome (no completion data, photo, or signature carries
   * over) — this is a new run, not a record of the old one.
   */
  async duplicate(companyId: string, actorUserId: string, jobId: string, dto: DuplicateJobDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const source = await this.support.requireJob(tx, companyId, jobId);
      const sourceStops = await tx.jobStop.findMany({ where: { jobId }, orderBy: { sequence: 'asc' } });

      let assetId: string | undefined;
      if (source.assetId) {
        const asset = await tx.asset.findUnique({ where: { id: source.assetId } });
        if (asset && !asset.archivedAt) assetId = asset.id;
      }
      let operatorId: string | undefined;
      if (source.operatorId) {
        const operator = await tx.operator.findUnique({ where: { id: source.operatorId } });
        if (operator && !operator.archivedAt) operatorId = operator.id;
      }

      const newJob = await tx.job.create({
        data: {
          companyId,
          title: source.title,
          description: source.description,
          assetId,
          operatorId,
          status: assetId || operatorId ? JobStatus.ASSIGNED : JobStatus.UNASSIGNED,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        },
      });

      if (assetId && operatorId) {
        await this.support.openOperatedRelationship(tx, companyId, operatorId, assetId);
      }

      if (sourceStops.length) {
        // One insert for all copied stops rather than a create-per-stop loop.
        await tx.jobStop.createMany({
          data: sourceStops.map((stop) => ({
            companyId,
            jobId: newJob.id,
            customerId: stop.customerId ?? undefined,
            sequence: stop.sequence,
            label: stop.label,
            address: stop.address,
            contactName: stop.contactName,
          })),
        });
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: newJob.id,
        eventType: 'created',
        summary: `Job "${newJob.title}" created (repeated from an earlier run).`,
        payload: { duplicatedFromJobId: jobId, stopCount: sourceStops.length },
        actorUserId,
      });

      if (operatorId) {
        await this.support.notifyAssignedOperator(tx, companyId, operatorId, newJob.title);
      }

      return tx.job.findUnique({ where: { id: newJob.id }, include: JOB_INCLUDE });
    });
  }

  async findAll(companyId: string, query: ListJobsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Jobs have no archivedAt — COMPLETED/CANCELLED are the terminal states
      // themselves, always visible. includeArchived has no effect here.
      const where: Prisma.JobWhereInput = {
        ...(query.operatorId ? { operatorId: query.operatorId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.view ? this.viewFilter(query.view) : {}),
      };
      const [items, total] = await Promise.all([
        tx.job.findMany({
          where,
          include: JOB_INCLUDE,
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.job.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const job = await this.prisma.withTenant(companyId, (tx) =>
      tx.job.findUnique({ where: { id }, include: JOB_INCLUDE }),
    );
    if (!job || job.companyId !== companyId) {
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    }
    return job;
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateJobDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.support.requireJob(tx, companyId, id);
      this.support.assertNotTerminal(existing);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['title', 'description'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }
      if (dto.scheduledAt !== undefined) {
        const next = new Date(dto.scheduledAt);
        if (next.getTime() !== existing.scheduledAt?.getTime()) {
          changed.scheduledAt = { from: existing.scheduledAt, to: next };
        }
      }

      const job = await tx.job.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description,
          scheduledAt: dto.scheduledAt !== undefined ? new Date(dto.scheduledAt) : undefined,
        },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.JOB,
          entityId: job.id,
          eventType: 'updated',
          summary: `Job "${job.title}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return job;
    });
  }

  async assign(companyId: string, actorUserId: string, id: string, dto: AssignJobDto) {
    if (dto.assetId === undefined && dto.operatorId === undefined && dto.pickupDepotId === undefined) {
      throw new BadRequestException({
        code: 'NOTHING_TO_ASSIGN',
        message: 'Provide assetId, operatorId, and/or pickupDepotId to assign.',
      });
    }

    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.support.requireJob(tx, companyId, id);
      this.support.assertNotTerminal(existing);

      // Optimistic concurrency: if the caller told us which version they saw and
      // the job has moved on since, reject rather than overwrite a newer state.
      // Returns the current job so the client can refresh and re-decide.
      if (dto.expectedUpdatedAt && existing.updatedAt.getTime() !== new Date(dto.expectedUpdatedAt).getTime()) {
        throw new ConflictException({
          code: 'JOB_MODIFIED',
          message: 'This job was changed by someone else since you loaded it. Refresh and try again.',
          currentJob: existing,
        });
      }

      const nextAssetId = dto.assetId === undefined ? existing.assetId : dto.assetId;
      const nextOperatorId = dto.operatorId === undefined ? existing.operatorId : dto.operatorId;
      const nextPickupDepotId = dto.pickupDepotId === undefined ? existing.pickupDepotId : dto.pickupDepotId;

      if (nextAssetId) await this.assets.requireAsset(tx, companyId, nextAssetId, { allowArchived: false });
      if (nextOperatorId) await this.operators.requireOperator(tx, companyId, nextOperatorId, { allowArchived: false });
      if (nextPickupDepotId) await this.depots.requireDepot(tx, companyId, nextPickupDepotId);

      const fatigueStatus = await this.resolveFatigueGate(companyId, dto, nextOperatorId);

      const pairChanged = nextAssetId !== existing.assetId || nextOperatorId !== existing.operatorId;
      if (pairChanged && existing.assetId && existing.operatorId) {
        await this.support.closeOperatedRelationship(tx, companyId, existing.operatorId, existing.assetId);
      }
      if (pairChanged && nextAssetId && nextOperatorId) {
        await this.support.openOperatedRelationship(tx, companyId, nextOperatorId, nextAssetId);
      }

      const job = await tx.job.update({
        where: { id },
        data: {
          assetId: nextAssetId,
          operatorId: nextOperatorId,
          pickupDepotId: nextPickupDepotId,
          status: nextAssetId || nextOperatorId ? JobStatus.ASSIGNED : JobStatus.UNASSIGNED,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: job.id,
        eventType: existing.assetId || existing.operatorId ? 'reassigned' : 'assigned',
        summary: `Job "${job.title}" ${existing.assetId || existing.operatorId ? 'reassigned' : 'assigned'}.`,
        payload: {
          assetId: { from: existing.assetId, to: nextAssetId },
          operatorId: { from: existing.operatorId, to: nextOperatorId },
        },
        actorUserId,
      });

      if (fatigueStatus && fatigueStatus.status !== 'ok' && fatigueStatus.status !== 'not_assessed' && nextOperatorId) {
        await this.fatigue.recordOverride(tx, companyId, nextOperatorId, job.id, actorUserId, fatigueStatus);
      }

      // Tell a newly-assigned operator (on their DriverOS) they have a job.
      if (nextOperatorId && nextOperatorId !== existing.operatorId) {
        await this.support.notifyAssignedOperator(tx, companyId, nextOperatorId, job.title);
      }

      return job;
    });
  }

  /**
   * 08-Compliance/Australian_Compliance.md's edge case: a manager can knowingly
   * dispatch an operator close to (or over) a fatigue limit — that's the
   * business's legal call, not the software's to block — but only with an
   * explicit acknowledgement. Returns the operator's fatigue status (so the
   * caller can log the override distinctly) or undefined when the operator
   * isn't changing; throws when a risky assignment isn't acknowledged.
   */
  private async resolveFatigueGate(
    companyId: string,
    dto: AssignJobDto,
    nextOperatorId: string | null,
  ): Promise<Awaited<ReturnType<FatigueService['getStatusForOperator']>> | undefined> {
    if (dto.operatorId === undefined || !nextOperatorId) return undefined;
    const fatigueStatus = await this.fatigue.getStatusForOperator(companyId, nextOperatorId);
    if (fatigueStatus.status !== 'ok' && fatigueStatus.status !== 'not_assessed' && !dto.acknowledgeFatigueRisk) {
      throw new ConflictException({
        code: 'FATIGUE_RISK_UNACKNOWLEDGED',
        message: `${fatigueStatus.operatorName} is ${fatigueStatus.status === 'breach' ? 'in breach of' : 'approaching'} a Standard Hours limit. Confirm to assign anyway.`,
        fatigueStatus,
      });
    }
    return fatigueStatus;
  }

  async complete(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.support.requireJob(tx, companyId, id);
      this.support.assertNotTerminal(existing);

      if (existing.assetId && existing.operatorId) {
        await this.support.closeOperatedRelationship(tx, companyId, existing.operatorId, existing.assetId);
      }

      const job = await tx.job.update({
        where: { id },
        data: { status: JobStatus.COMPLETED, completedAt: new Date() },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: job.id,
        eventType: 'completed',
        summary: `Job "${job.title}" completed.`,
        actorUserId,
      });

      return job;
    });
  }

  async cancel(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.support.requireJob(tx, companyId, id);
      this.support.assertNotTerminal(existing);

      if (existing.assetId && existing.operatorId) {
        await this.support.closeOperatedRelationship(tx, companyId, existing.operatorId, existing.assetId);
      }

      const job = await tx.job.update({
        where: { id },
        data: { status: JobStatus.CANCELLED, cancelledAt: new Date() },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.JOB,
        entityId: job.id,
        eventType: 'cancelled',
        summary: `Job "${job.title}" cancelled.`,
        actorUserId,
      });

      return job;
    });
  }

  /** See ListJobsDto's `view` doc comment — every job falls into exactly one bucket. */
  private viewFilter(view: 'today' | 'upcoming' | 'history'): Prisma.JobWhereInput {
    const terminalStatuses: JobStatus[] = [JobStatus.COMPLETED, JobStatus.CANCELLED];
    if (view === 'history') return { status: { in: terminalStatuses } };

    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    const notTerminal: Prisma.JobWhereInput = { status: { notIn: terminalStatuses } };
    if (view === 'upcoming') return { ...notTerminal, scheduledAt: { gt: endOfToday } };
    return { ...notTerminal, OR: [{ scheduledAt: null }, { scheduledAt: { lte: endOfToday } }] };
  }

}
