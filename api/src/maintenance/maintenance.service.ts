import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { MaintenanceJobStatus, Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AssetsService } from '../assets/assets.service';
import { OperatorsService } from '../operators/operators.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { CreateMaintenanceJobDto } from './dto/create-maintenance-job.dto';
import { UpdateMaintenanceJobDto } from './dto/update-maintenance-job.dto';
import { CloseMaintenanceJobDto } from './dto/close-maintenance-job.dto';
import { RecordPartsUsedDto } from './dto/record-parts-used.dto';

const PARTS_USED_INCLUDE = { partsUsed: { include: { part: true }, orderBy: { createdAt: 'asc' as const } } };

/**
 * The Workshop milestone's scoped slice (06-Workshop/Workshop_Overview.md):
 * manual job logging, a linear status lifecycle, and an optional approval
 * record. No Smart Checklist/OBD auto-creation, no
 * service-due scheduling, no parts inventory — see the doc's implementation
 * notes for the full reasoning.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly assets: AssetsService,
    private readonly operators: OperatorsService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateMaintenanceJobDto) {
    try {
      return await this.createInner(companyId, actorUserId, dto);
    } catch (err) {
      // Lost the idempotent-replay race: a concurrent request with the same
      // clientRequestId (offline outbox replay racing a live retry, or a
      // double-tap) read null and both inserted — the loser hits the
      // [companyId, clientRequestId] unique constraint (P2002). Re-read and
      // return the winner as the idempotent success it is (established pattern —
      // parcels.scanParcel, customers.importByName). No unhandled 500.
      if (dto.clientRequestId && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.withTenant(companyId, (tx) =>
          tx.maintenanceJob.findFirst({ where: { companyId, clientRequestId: dto.clientRequestId } }),
        );
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async createInner(companyId: string, actorUserId: string, dto: CreateMaintenanceJobDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Idempotent replay: a DriverOS fault report queued offline and re-sent
      // after a lost response carries a stable clientRequestId — return the
      // existing job rather than opening a duplicate workshop job.
      if (dto.clientRequestId) {
        const existing = await tx.maintenanceJob.findFirst({
          where: { companyId, clientRequestId: dto.clientRequestId },
        });
        if (existing) return existing;
      }

      // Reject archived assets/operators too (allowArchived: false) — a job
      // can't be filed against a retired asset or reporter — matching the
      // behaviour of the private guards these replaced.
      await this.assets.requireAsset(tx, companyId, dto.assetId, { allowArchived: false });
      if (dto.reportedByOperatorId) {
        await this.operators.requireOperator(tx, companyId, dto.reportedByOperatorId, { allowArchived: false });
      }

      const job = await tx.maintenanceJob.create({
        data: {
          companyId,
          assetId: dto.assetId,
          title: dto.title,
          description: dto.description,
          reportedByOperatorId: dto.reportedByOperatorId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.MAINTENANCE_JOB,
        entityId: job.id,
        eventType: 'created',
        summary: `Maintenance job "${job.title}" logged.`,
        actorUserId,
      });

      return job;
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      // Maintenance jobs have no archivedAt — Complete is a terminal status,
      // always visible, same reasoning as Job (05-Dispatch).
      const [items, total] = await Promise.all([
        tx.maintenanceJob.findMany({
          include: { asset: true, reportedByOperator: true, ...PARTS_USED_INCLUDE },
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.maintenanceJob.count(),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const job = await this.prisma.withTenant(companyId, (tx) =>
      tx.maintenanceJob.findUnique({
        where: { id },
        include: { asset: true, reportedByOperator: true, ...PARTS_USED_INCLUDE },
      }),
    );
    if (!job || job.companyId !== companyId) {
      throw new NotFoundException({ code: 'MAINTENANCE_JOB_NOT_FOUND', message: 'Maintenance job not found.' });
    }
    return job;
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateMaintenanceJobDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireJob(tx, companyId, id);
      this.assertNotComplete(existing);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['title', 'description', 'status'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const job = await tx.maintenanceJob.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description,
          status: dto.status,
        },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.MAINTENANCE_JOB,
          entityId: job.id,
          eventType: 'updated',
          summary: `Maintenance job "${job.title}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return job;
    });
  }

  async approve(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireJob(tx, companyId, id);
      this.assertNotComplete(existing);
      if (existing.approvedAt) {
        throw new ConflictException({
          code: 'ALREADY_APPROVED',
          message: 'This maintenance job has already been approved.',
        });
      }

      const job = await tx.maintenanceJob.update({
        where: { id },
        data: { approvedAt: new Date(), approvedByUserId: actorUserId },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.MAINTENANCE_JOB,
        entityId: job.id,
        eventType: 'approved',
        summary: `Maintenance job "${job.title}" approved.`,
        actorUserId,
      });

      return job;
    });
  }

  async close(companyId: string, actorUserId: string, id: string, dto: CloseMaintenanceJobDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireJob(tx, companyId, id);
      this.assertNotComplete(existing);

      const job = await tx.maintenanceJob.update({
        where: { id },
        data: {
          status: MaintenanceJobStatus.COMPLETE,
          completedAt: new Date(),
          resolutionNotes: dto.resolutionNotes,
          partsCost: dto.partsCost,
          laborCost: dto.laborCost,
        },
      });

      const payload: Record<string, unknown> = {};
      if (dto.resolutionNotes) payload.resolutionNotes = dto.resolutionNotes;
      if (dto.partsCost !== undefined) payload.partsCost = dto.partsCost;
      if (dto.laborCost !== undefined) payload.laborCost = dto.laborCost;

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.MAINTENANCE_JOB,
        entityId: job.id,
        eventType: 'closed',
        summary: `Maintenance job "${job.title}" closed.`,
        payload: Object.keys(payload).length > 0 ? payload : undefined,
        actorUserId,
      });

      return job;
    });
  }

  /**
   * Parts inventory basics (06-Workshop/Workshop_Overview.md's "Future
   * expansion notes"): log a part used against a job, decrementing stock and
   * snapshotting its unit cost at the time of use. Allowed any time before
   * the job is closed — a technician logs parts as they go, not only at the
   * end. Insufficient stock is rejected rather than allowed to go negative;
   * the fix is a stock adjustment (`PATCH /v1/parts/:id`) first.
   */
  async recordPartsUsed(companyId: string, actorUserId: string, jobId: string, dto: RecordPartsUsedDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await this.requireJob(tx, companyId, jobId);
      this.assertNotComplete(job);

      const part = await tx.part.findUnique({ where: { id: dto.partId } });
      if (!part || part.companyId !== companyId || part.archivedAt) {
        throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Part not found.' });
      }
      if (part.quantityOnHand < dto.quantity) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: `Only ${part.quantityOnHand} of "${part.name}" in stock.`,
        });
      }

      // Atomic guarded decrement: the `quantityOnHand >= quantity` predicate is
      // evaluated by Postgres under the row lock the UPDATE takes, so two
      // concurrent parts-usage submissions against the same part can't both pass
      // and drive stock negative — the loser matches zero rows. The findUnique
      // check above only produces the friendly "only N in stock" message in the
      // common (uncontended) case; this is the authoritative guard.
      const decremented = await tx.part.updateMany({
        where: { id: part.id, companyId, quantityOnHand: { gte: dto.quantity } },
        data: { quantityOnHand: { decrement: dto.quantity } },
      });
      if (decremented.count === 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: `Only ${part.quantityOnHand} of "${part.name}" in stock.`,
        });
      }
      // Re-read within the same transaction to report the true remaining count.
      const updatedPart = await tx.part.findUniqueOrThrow({ where: { id: part.id } });

      const usage = await tx.maintenanceJobPartUsage.create({
        data: {
          companyId,
          maintenanceJobId: jobId,
          partId: part.id,
          quantity: dto.quantity,
          unitCostAtUse: part.unitCost,
        },
        include: { part: true },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.MAINTENANCE_JOB,
        entityId: jobId,
        eventType: 'parts_used',
        summary: `${dto.quantity} × "${part.name}" logged against maintenance job "${job.title}".`,
        actorUserId,
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.PART,
        entityId: part.id,
        eventType: 'used',
        summary: `${dto.quantity} used on maintenance job "${job.title}"; ${updatedPart.quantityOnHand} remaining.`,
        actorUserId,
      });

      return usage;
    });
  }

  private async requireJob(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const job = await tx.maintenanceJob.findUnique({ where: { id } });
    if (!job || job.companyId !== companyId) {
      throw new NotFoundException({ code: 'MAINTENANCE_JOB_NOT_FOUND', message: 'Maintenance job not found.' });
    }
    return job;
  }

  private assertNotComplete(job: { status: MaintenanceJobStatus }) {
    if (job.status === MaintenanceJobStatus.COMPLETE) {
      throw new ConflictException({
        code: 'MAINTENANCE_JOB_CLOSED',
        message: 'This maintenance job has already been closed.',
      });
    }
  }

}
