import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdjustStockDto,
  CreateStockItemDto,
  ImportStockRowsDto,
  ListStockDto,
  UpdateStockItemDto,
} from './dto/stock.dto';
import {
  CreateMachineDto,
  CreateMachineLogDto,
  ListMachinesDto,
  UpdateMachineDto,
} from './dto/machine.dto';
import { CreateMachinePlanDto, UpdateMachinePlanDto } from './dto/machine-plan.dto';

/**
 * The Warehouse add-on: customer stock inventory + warehouse machines with
 * maintenance/monitoring logs. Deliberately schema-light and customizable —
 * `attributes` JSON on stock/machines and free-text status/type/category
 * strings mean a customer's own vocabulary never needs a migration.
 *
 * CRITICAL: nothing in this service (or its controller) checks a billing
 * entitlement. The Warehouse add-on may be *promoted* as paid in the UI, but a
 * customer must always be able to add and import their stock and machines from
 * day one — see billing/plans.ts FeatureKey doc.
 */
@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService) {}

  private toJson(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
    return value === undefined ? undefined : (value as Prisma.InputJsonValue);
  }

  // ---- Stock ----------------------------------------------------------------

  async createStock(companyId: string, dto: CreateStockItemDto) {
    return this.prisma.withTenant(companyId, (tx) =>
      tx.stockItem.create({
        data: {
          companyId,
          name: dto.name.trim(),
          sku: dto.sku?.trim() || null,
          description: dto.description?.trim() || null,
          category: dto.category?.trim() || null,
          quantity: dto.quantity ?? 0,
          unit: dto.unit?.trim() || null,
          location: dto.location?.trim() || null,
          minQuantity: dto.minQuantity ?? null,
          attributes: this.toJson(dto.attributes),
        },
      }),
    );
  }

  async listStock(companyId: string, query: ListStockDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.StockItemWhereInput = query.includeArchived ? {} : { archivedAt: null };
      if (query.category) where.category = query.category;
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { sku: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ];
      }
      const [items, total, grouped] = await Promise.all([
        tx.stockItem.findMany({ where, orderBy: [{ name: 'asc' }], skip: query.skip, take: query.take }),
        tx.stockItem.count({ where }),
        tx.stockItem.groupBy({ by: ['category'], where: { archivedAt: null, category: { not: null } } }),
      ]);
      const categories = grouped.map((g) => g.category).filter((c): c is string => !!c).sort();
      // Low-stock is derived, not stored — filter in memory (small sets) so the
      // threshold comparison against a nullable column stays simple.
      const lowStockItems = items.filter((i) => i.minQuantity != null && i.quantity <= i.minQuantity);
      const filtered = query.lowStock === 'true' ? lowStockItems : items;
      return { items: filtered, total, categories, lowStockCount: lowStockItems.length, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async updateStock(companyId: string, id: string, dto: UpdateStockItemDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireStock(tx, companyId, id);
      return tx.stockItem.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          sku: dto.sku === undefined ? undefined : dto.sku.trim() || null,
          description: dto.description === undefined ? undefined : dto.description.trim() || null,
          category: dto.category === undefined ? undefined : dto.category.trim() || null,
          quantity: dto.quantity,
          unit: dto.unit === undefined ? undefined : dto.unit.trim() || null,
          location: dto.location === undefined ? undefined : dto.location.trim() || null,
          minQuantity: dto.minQuantity === undefined ? undefined : dto.minQuantity,
          attributes: this.toJson(dto.attributes),
        },
      });
    });
  }

  async adjustStock(companyId: string, actorUserId: string, id: string, dto: AdjustStockDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const item = await this.requireStock(tx, companyId, id);
      const next = Math.max(0, item.quantity + dto.delta);
      const updated = await tx.stockItem.update({ where: { id }, data: { quantity: next } });
      // Record the change in the append-only adjustment ledger so the operator's
      // reason ("5 damaged in transit") is kept, not discarded. `delta` is the
      // effective change actually applied — clamping at 0 can make it differ
      // from the requested dto.delta, and the ledger records what happened.
      await tx.stockAdjustment.create({
        data: {
          companyId,
          stockItemId: id,
          delta: next - item.quantity,
          quantityAfter: next,
          reason: dto.reason?.trim() || null,
          actorUserId,
        },
      });
      return updated;
    });
  }

  /** The adjustment history for one stock item, newest first. */
  async listStockAdjustments(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireStock(tx, companyId, id);
      const items = await tx.stockAdjustment.findMany({
        where: { stockItemId: id },
        orderBy: [{ createdAt: 'desc' }],
        include: { actorUser: { select: { id: true, fullName: true } } },
      });
      return { items };
    });
  }

  async archiveStock(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const item = await this.requireStock(tx, companyId, id);
      if (item.archivedAt) return item;
      return tx.stockItem.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  /** Bulk import — "move their entire stock over with ease". Best-effort per row. */
  async importStock(companyId: string, dto: ImportStockRowsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      let created = 0;
      const errors: { index: number; message: string }[] = [];
      for (let i = 0; i < dto.rows.length; i++) {
        const row = dto.rows[i];
        try {
          await tx.stockItem.create({
            data: {
              companyId,
              name: row.name.trim(),
              sku: row.sku?.trim() || null,
              description: row.description?.trim() || null,
              category: row.category?.trim() || null,
              quantity: row.quantity ?? 0,
              unit: row.unit?.trim() || null,
              location: row.location?.trim() || null,
              minQuantity: row.minQuantity ?? null,
              attributes: this.toJson(row.attributes),
            },
          });
          created++;
        } catch (err) {
          errors.push({ index: i, message: err instanceof Error ? err.message : 'Failed to import row' });
        }
      }
      return { created, failed: errors.length, total: dto.rows.length, errors };
    });
  }

  // ---- Machines -------------------------------------------------------------

  async createMachine(companyId: string, dto: CreateMachineDto) {
    return this.prisma.withTenant(companyId, (tx) =>
      tx.warehouseMachine.create({
        data: {
          companyId,
          name: dto.name.trim(),
          machineType: dto.machineType?.trim() || null,
          serialNumber: dto.serialNumber?.trim() || null,
          status: dto.status ?? 'OPERATIONAL',
          location: dto.location?.trim() || null,
          notes: dto.notes?.trim() || null,
          attributes: this.toJson(dto.attributes),
          lastServiceAt: dto.lastServiceAt ? new Date(dto.lastServiceAt) : null,
          nextServiceDueAt: dto.nextServiceDueAt ? new Date(dto.nextServiceDueAt) : null,
        },
      }),
    );
  }

  async listMachines(companyId: string, query: ListMachinesDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.WarehouseMachineWhereInput = query.includeArchived ? {} : { archivedAt: null };
      if (query.status) where.status = query.status;
      if (query.search) {
        where.OR = [
          { name: { contains: query.search, mode: 'insensitive' } },
          { machineType: { contains: query.search, mode: 'insensitive' } },
          { serialNumber: { contains: query.search, mode: 'insensitive' } },
        ];
      }
      const [items, total] = await Promise.all([
        tx.warehouseMachine.findMany({
          where,
          orderBy: [{ name: 'asc' }],
          skip: query.skip,
          take: query.take,
          include: { _count: { select: { logs: true } } },
        }),
        tx.warehouseMachine.count({ where }),
      ]);
      const needsAttention = await tx.warehouseMachine.count({
        where: { archivedAt: null, status: { in: ['NEEDS_ATTENTION', 'DOWN'] } },
      });
      return { items, total, needsAttentionCount: needsAttention, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async updateMachine(companyId: string, id: string, dto: UpdateMachineDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachine(tx, companyId, id);
      return tx.warehouseMachine.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          machineType: dto.machineType === undefined ? undefined : dto.machineType.trim() || null,
          serialNumber: dto.serialNumber === undefined ? undefined : dto.serialNumber.trim() || null,
          status: dto.status,
          location: dto.location === undefined ? undefined : dto.location.trim() || null,
          notes: dto.notes === undefined ? undefined : dto.notes.trim() || null,
          attributes: this.toJson(dto.attributes),
          lastServiceAt: dto.lastServiceAt === undefined ? undefined : dto.lastServiceAt ? new Date(dto.lastServiceAt) : null,
          nextServiceDueAt:
            dto.nextServiceDueAt === undefined ? undefined : dto.nextServiceDueAt ? new Date(dto.nextServiceDueAt) : null,
        },
      });
    });
  }

  async archiveMachine(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const machine = await this.requireMachine(tx, companyId, id);
      if (machine.archivedAt) return machine;
      return tx.warehouseMachine.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  // ---- Machine logs ---------------------------------------------------------

  async addMachineLog(companyId: string, actorUserId: string, machineId: string, dto: CreateMachineLogDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachine(tx, companyId, machineId);
      const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
      const log = await tx.warehouseMachineLog.create({
        data: {
          companyId,
          machineId,
          kind: dto.kind,
          summary: dto.summary.trim(),
          meterValue: dto.meterValue ?? null,
          meterUnit: dto.meterUnit?.trim() || null,
          occurredAt,
          createdByUserId: actorUserId,
        },
      });
      // A SERVICE entry advances the machine's last-service marker.
      if (dto.kind === 'SERVICE') {
        await tx.warehouseMachine.update({ where: { id: machineId }, data: { lastServiceAt: occurredAt } });
      }
      return log;
    });
  }

  async listMachineLogs(companyId: string, machineId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachine(tx, companyId, machineId);
      const items = await tx.warehouseMachineLog.findMany({
        where: { machineId },
        orderBy: [{ occurredAt: 'desc' }],
        include: { createdByUser: { select: { id: true, fullName: true } } },
      });
      return { items };
    });
  }

  // ---- Machine maintenance schedules (savable/deployable plans) --------------

  /** Starter machine schedule presets a customer can seed from. */
  machinePlanPresets() {
    return [
      { name: 'Forklift basics', items: [{ label: 'Service', intervalDays: 90 }, { label: 'Hydraulics check', intervalDays: 180 }, { label: 'Annual inspection', intervalDays: 365 }] },
      { name: 'Wrapper / conveyor basics', items: [{ label: 'Service', intervalDays: 120 }, { label: 'Belt / film-carriage check', intervalDays: 180 }] },
    ];
  }

  async listMachinePlansForMachine(companyId: string, machineId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachine(tx, companyId, machineId);
      const plans = await tx.warehouseMachinePlan.findMany({ where: { machineId, archivedAt: null } });
      const now = new Date();
      return { items: plans.map((p) => this.planWithStatus(p, now)).sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime()) };
    });
  }

  async listAllMachinePlans(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const plans = await tx.warehouseMachinePlan.findMany({
        where: { archivedAt: null },
        include: { machine: { select: { id: true, name: true } } },
      });
      const now = new Date();
      const items = plans.map((p) => this.planWithStatus(p, now)).sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime());
      return {
        items,
        overdueCount: items.filter((p) => p.status === 'overdue').length,
        dueSoonCount: items.filter((p) => p.status === 'due_soon').length,
      };
    });
  }

  async createMachinePlan(companyId: string, machineId: string, dto: CreateMachinePlanDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachine(tx, companyId, machineId);
      const plan = await tx.warehouseMachinePlan.create({
        data: {
          companyId,
          machineId,
          label: dto.label.trim(),
          intervalDays: dto.intervalDays,
          lastServiceAt: dto.lastServiceAt ? new Date(dto.lastServiceAt) : null,
        },
      });
      return this.planWithStatus(plan, new Date());
    });
  }

  async updateMachinePlan(companyId: string, id: string, dto: UpdateMachinePlanDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachinePlan(tx, companyId, id);
      const plan = await tx.warehouseMachinePlan.update({
        where: { id },
        data: {
          label: dto.label?.trim(),
          intervalDays: dto.intervalDays,
          lastServiceAt: dto.lastServiceAt === undefined ? undefined : dto.lastServiceAt ? new Date(dto.lastServiceAt) : null,
        },
      });
      return this.planWithStatus(plan, new Date());
    });
  }

  /** Mark serviced now: reset the clock, log a SERVICE entry, advance the machine marker. */
  async serviceMachinePlan(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const plan = await this.requireMachinePlan(tx, companyId, id);
      const now = new Date();
      const updated = await tx.warehouseMachinePlan.update({ where: { id }, data: { lastServiceAt: now } });
      await tx.warehouseMachineLog.create({
        data: { companyId, machineId: plan.machineId, kind: 'SERVICE', summary: `Scheduled service: ${plan.label}`, occurredAt: now, createdByUserId: actorUserId },
      });
      await tx.warehouseMachine.update({ where: { id: plan.machineId }, data: { lastServiceAt: now } });
      return this.planWithStatus(updated, now);
    });
  }

  async archiveMachinePlan(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const plan = await this.requireMachinePlan(tx, companyId, id);
      if (plan.archivedAt) return this.planWithStatus(plan, new Date());
      const updated = await tx.warehouseMachinePlan.update({ where: { id }, data: { archivedAt: new Date() } });
      return this.planWithStatus(updated, new Date());
    });
  }

  /** Copy one machine's active schedule to other machines — idempotent by label. */
  async copyMachineSchedule(companyId: string, fromMachineId: string, targetMachineIds: string[]) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireMachine(tx, companyId, fromMachineId);
      const source = await tx.warehouseMachinePlan.findMany({ where: { machineId: fromMachineId, archivedAt: null } });
      const targets = (await tx.warehouseMachine.findMany({ where: { id: { in: targetMachineIds }, companyId, archivedAt: null }, select: { id: true } })).filter(
        (t) => t.id !== fromMachineId,
      );

      // Set-based, matching maintenance-schedules.deployTemplate: one read of
      // existing plans, then in-memory revive/create with batched writes —
      // instead of a findFirst per (target machine × source item).
      const itemByLabel = new Map(source.map((i) => [i.label, i]));
      const labels = source.map((i) => i.label);
      const targetIds = targets.map((t) => t.id);
      const existing = targetIds.length
        ? await tx.warehouseMachinePlan.findMany({
            where: { machineId: { in: targetIds }, label: { in: labels } },
            select: { id: true, machineId: true, label: true, archivedAt: true },
          })
        : [];
      const existingKeys = new Set(existing.map((e) => `${e.machineId}::${e.label}`));

      const reviveIdsByLabel = new Map<string, string[]>();
      for (const e of existing) {
        if (!e.archivedAt) continue;
        const arr = reviveIdsByLabel.get(e.label) ?? [];
        arr.push(e.id);
        reviveIdsByLabel.set(e.label, arr);
      }
      let revived = 0;
      for (const [label, ids] of reviveIdsByLabel) {
        const item = itemByLabel.get(label);
        if (!item) continue;
        const res = await tx.warehouseMachinePlan.updateMany({ where: { id: { in: ids } }, data: { archivedAt: null, intervalDays: item.intervalDays } });
        revived += res.count;
      }

      const toCreate = targets.flatMap((target) =>
        source
          .filter((item) => !existingKeys.has(`${target.id}::${item.label}`))
          .map((item) => ({ companyId, machineId: target.id, label: item.label, intervalDays: item.intervalDays, templateId: item.templateId })),
      );
      if (toCreate.length) await tx.warehouseMachinePlan.createMany({ data: toCreate });

      return { machinesTargeted: targets.length, plansCreated: toCreate.length, plansRevived: revived };
    });
  }

  private planWithStatus(
    plan: { id: string; machineId: string; label: string; intervalDays: number; lastServiceAt: Date | null; createdAt: Date; machine?: { id: string; name: string } },
    now: Date,
  ) {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const baseline = plan.lastServiceAt ?? plan.createdAt;
    const nextDueAt = new Date(baseline.getTime() + plan.intervalDays * DAY_MS);
    const daysUntilDue = Math.round((nextDueAt.getTime() - now.getTime()) / DAY_MS);
    const status: 'ok' | 'due_soon' | 'overdue' = daysUntilDue < 0 ? 'overdue' : daysUntilDue <= 14 ? 'due_soon' : 'ok';
    return { id: plan.id, machineId: plan.machineId, machine: plan.machine, label: plan.label, intervalDays: plan.intervalDays, lastServiceAt: plan.lastServiceAt, nextDueAt, daysUntilDue, status };
  }

  private async requireMachinePlan(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const plan = await tx.warehouseMachinePlan.findUnique({ where: { id } });
    if (!plan || plan.companyId !== companyId) {
      throw new NotFoundException({ code: 'MACHINE_PLAN_NOT_FOUND', message: 'Machine maintenance plan not found.' });
    }
    return plan;
  }

  // ---- helpers --------------------------------------------------------------

  private async requireStock(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const item = await tx.stockItem.findUnique({ where: { id } });
    if (!item || item.companyId !== companyId) {
      throw new NotFoundException({ code: 'STOCK_ITEM_NOT_FOUND', message: 'Stock item not found.' });
    }
    return item;
  }

  private async requireMachine(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const machine = await tx.warehouseMachine.findUnique({ where: { id } });
    if (!machine || machine.companyId !== companyId) {
      throw new NotFoundException({ code: 'MACHINE_NOT_FOUND', message: 'Machine not found.' });
    }
    return machine;
  }
}
