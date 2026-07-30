import { Injectable, NotFoundException } from '@nestjs/common';
import { Part, Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { CreatePartDto } from './dto/create-part.dto';
import { UpdatePartDto } from './dto/update-part.dto';

function withLowStock(part: Part) {
  return { ...part, isLowStock: part.lowStockThreshold != null && part.quantityOnHand <= part.lowStockThreshold };
}

/**
 * Parts inventory basics (06-Workshop/Workshop_Overview.md's "Future
 * expansion notes"): a simple catalog with a quantity on hand, mirroring the
 * Customer/Depot reference-record pattern. No supplier integration, no
 * reorder automation, no multi-location stock.
 */
@Injectable()
export class PartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreatePartDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const part = await tx.part.create({
        data: {
          companyId,
          name: dto.name,
          partNumber: dto.partNumber,
          quantityOnHand: dto.quantityOnHand ?? 0,
          unitCost: dto.unitCost,
          lowStockThreshold: dto.lowStockThreshold,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.PART,
        entityId: part.id,
        eventType: 'created',
        summary: `Part "${part.name}" added to the catalog.`,
        actorUserId,
      });

      return withLowStock(part);
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where = query.includeArchived ? {} : { archivedAt: null };
      const [items, total] = await Promise.all([
        tx.part.findMany({ where, orderBy: { name: 'asc' }, skip: query.skip, take: query.take }),
        tx.part.count({ where }),
      ]);
      return { items: items.map(withLowStock), total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const part = await this.prisma.withTenant(companyId, (tx) => tx.part.findUnique({ where: { id } }));
    if (!part || part.companyId !== companyId) {
      throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Part not found.' });
    }
    return withLowStock(part);
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdatePartDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requirePart(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['name', 'partNumber', 'quantityOnHand', 'unitCost', 'lowStockThreshold'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }

      const part = await tx.part.update({
        where: { id },
        data: {
          name: dto.name,
          partNumber: dto.partNumber,
          quantityOnHand: dto.quantityOnHand,
          unitCost: dto.unitCost,
          lowStockThreshold: dto.lowStockThreshold,
        },
      });

      if (Object.keys(changed).length > 0) {
        const isStockOnlyAdjustment = Object.keys(changed).length === 1 && 'quantityOnHand' in changed;
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.PART,
          entityId: part.id,
          eventType: isStockOnlyAdjustment ? 'stock_adjusted' : 'updated',
          summary: isStockOnlyAdjustment
            ? `Part "${part.name}" stock adjusted from ${changed.quantityOnHand.from} to ${changed.quantityOnHand.to}.`
            : `Part "${part.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return withLowStock(part);
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requirePart(tx, companyId, id);
      if (existing.archivedAt) return withLowStock(existing);

      const part = await tx.part.update({ where: { id }, data: { archivedAt: new Date() } });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.PART,
        entityId: part.id,
        eventType: 'archived',
        summary: `Part "${part.name}" archived.`,
        actorUserId,
      });

      return withLowStock(part);
    });
  }

  async requirePart(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const part = await tx.part.findUnique({ where: { id } });
    if (!part || part.companyId !== companyId) {
      throw new NotFoundException({ code: 'PART_NOT_FOUND', message: 'Part not found.' });
    }
    return part;
  }
}
