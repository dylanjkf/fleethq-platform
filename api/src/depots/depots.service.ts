import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { CreateDepotDto } from './dto/create-depot.dto';
import { UpdateDepotDto } from './dto/update-depot.dto';

/**
 * The fleet's own pickup locations (courier vertical, 00-Company/Commercial_Priority.md):
 * depots, warehouses, branches — distinct from Customer (who the fleet
 * delivers TO). Mirrors the Customer/AttachedUnit reference-record pattern
 * exactly.
 */
@Injectable()
export class DepotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  // actorUserId is optional so the Integration Sync Engine can create rows for
  // a SCHEDULED/webhook-triggered sync (no human in the loop) via this exact
  // path — TimelineService already attributes an absent actor to SYSTEM.
  async create(companyId: string, actorUserId: string | undefined, dto: CreateDepotDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const depot = await tx.depot.create({
        data: { companyId, name: dto.name, address: dto.address, notes: dto.notes },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.DEPOT,
        entityId: depot.id,
        eventType: 'created',
        summary: `Depot "${depot.name}" created.`,
        actorUserId,
      });

      return depot;
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const term = query.searchTerm;
      const where: Prisma.DepotWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { address: { contains: term, mode: 'insensitive' } },
                { notes: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const [items, total] = await Promise.all([
        tx.depot.findMany({ where, orderBy: { name: 'asc' }, skip: query.skip, take: query.take }),
        tx.depot.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const depot = await this.prisma.withTenant(companyId, (tx) => tx.depot.findUnique({ where: { id } }));
    if (!depot || depot.companyId !== companyId) {
      throw new NotFoundException({ code: 'DEPOT_NOT_FOUND', message: 'Depot not found.' });
    }
    return depot;
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateDepotDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireDepot(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'address', 'notes'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const depot = await tx.depot.update({
        where: { id },
        data: { name: dto.name, address: dto.address, notes: dto.notes },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.DEPOT,
          entityId: depot.id,
          eventType: 'updated',
          summary: `Depot "${depot.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return depot;
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireDepot(tx, companyId, id);
      if (existing.archivedAt) return existing;

      const depot = await tx.depot.update({ where: { id }, data: { archivedAt: new Date() } });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.DEPOT,
        entityId: depot.id,
        eventType: 'archived',
        summary: `Depot "${depot.name}" archived.`,
        actorUserId,
      });

      return depot;
    });
  }

  async requireDepot(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const depot = await tx.depot.findUnique({ where: { id } });
    if (!depot || depot.companyId !== companyId) {
      throw new NotFoundException({ code: 'DEPOT_NOT_FOUND', message: 'Depot not found.' });
    }
    return depot;
  }

  /** Finds an active depot by exact (case-insensitive) name — the import de-dup matcher. */
  async findByName(tx: Prisma.TransactionClient, companyId: string, name: string) {
    return tx.depot.findFirst({
      where: { companyId, archivedAt: null, name: { equals: name, mode: 'insensitive' } },
    });
  }

  /**
   * Natural-key upsert used by the CSV bulk-import / Integration Sync path: an
   * incoming row whose (case-insensitive) name already matches a live depot is
   * treated as that existing depot rather than inserted again, so re-importing
   * the same directory is idempotent (the audit found re-imports duplicated
   * every row). A genuinely new name is created exactly as `create()` would
   * (same write + Timeline event). The `depots_company_id_name_active_key`
   * partial-unique index (migration 20260801100000) is the race-safe backstop:
   * a concurrent insert that wins the same name surfaces as P2002, which is
   * re-resolved to the now-existing row. `created` lets the importer report an
   * insert vs. a de-dup skip without a new result field.
   */
  async importByName(
    companyId: string,
    actorUserId: string | undefined,
    dto: CreateDepotDto,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.prisma.withTenant(companyId, (tx) => this.findByName(tx, companyId, dto.name));
    if (existing) return { id: existing.id, created: false };
    try {
      const depot = await this.create(companyId, actorUserId, dto);
      return { id: depot.id, created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.withTenant(companyId, (tx) => this.findByName(tx, companyId, dto.name));
        if (raced) return { id: raced.id, created: false };
      }
      throw err;
    }
  }
}
