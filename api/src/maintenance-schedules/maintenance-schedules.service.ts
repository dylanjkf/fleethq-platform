import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { CreatePlanDto, CreateTemplateDto, DeployTemplateDto, UpdatePlanDto, UpdateTemplateDto } from './dto/schedule.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 14;

export type PlanStatus = 'ok' | 'due_soon' | 'overdue';

interface ScheduleItem {
  label: string;
  intervalDays: number;
}

/**
 * Maintenance schedules: savable templates (a reusable "layout") and the
 * per-asset plans deployed from them. Time-based in v1 — a plan's next-due date
 * is (lastServiceAt ?? createdAt) + intervalDays, and its status is derived at
 * read time. Nothing here writes a stored status.
 */
@Injectable()
export class MaintenanceSchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Alert the office about per-asset maintenance plans that have just crossed
   * into "due soon" or "overdue". Called per-company by the leader-elected
   * SchedulerService (opt-in), the exact counterpart to
   * ComplianceService.sweepExpiries. Idempotent: each plan carries
   * dueAlertedAt / overdueAlertedAt marks, so an alert fires exactly once per
   * stage over a service cycle — running the sweep twice, or every day, never
   * re-notifies. Servicing a plan (or editing its due date) resets the marks,
   * starting a fresh alert lifecycle for the next cycle. Fans out to every user
   * holding maintenance:view, the same permission the schedules read uses.
   *
   * A plan's next-due date is derived (baseline + intervalDays), not a stored
   * column, so — unlike the compliance sweep's DB-level expiry filter — the
   * candidate set is the active, not-yet-alerted plans and due-ness is computed
   * in JS, matching how listAllPlans already derives status. Runs inside a
   * single per-tenant transaction (RLS scopes every query).
   */
  async sweepDue(companyId: string): Promise<{ due: number; overdue: number }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const now = new Date();

      // Overdue: past due and never alerted for it — the escalated case.
      const overdueCandidates = await tx.assetMaintenancePlan.findMany({
        where: { archivedAt: null, overdueAlertedAt: null },
        include: { asset: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      let overdue = 0;
      for (const plan of overdueCandidates) {
        const nextDueAt = this.nextDueAt(plan);
        if (nextDueAt.getTime() >= now.getTime()) continue;
        await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.MAINTENANCE_VIEW, {
          type: 'maintenance_overdue',
          title: `${plan.label} for ${plan.asset.name} is overdue`,
          body: `Was due ${nextDueAt.toLocaleDateString('en-AU')}.`,
          linkPath: '/maintenance-schedules',
        });
        await tx.assetMaintenancePlan.update({ where: { id: plan.id }, data: { overdueAlertedAt: now } });
        overdue += 1;
      }

      // Due soon: in the [today .. +14d] window, not yet alerted for due, and
      // not already past due (handled as overdue above).
      const dueCandidates = await tx.assetMaintenancePlan.findMany({
        where: { archivedAt: null, dueAlertedAt: null },
        include: { asset: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      });
      let due = 0;
      for (const plan of dueCandidates) {
        const nextDueAt = this.nextDueAt(plan);
        const daysUntilDue = Math.round((nextDueAt.getTime() - now.getTime()) / DAY_MS);
        if (daysUntilDue < 0 || daysUntilDue > DUE_SOON_DAYS) continue;
        await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.MAINTENANCE_VIEW, {
          type: 'maintenance_due',
          title: `${plan.label} for ${plan.asset.name} is due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`,
          body: `Due ${nextDueAt.toLocaleDateString('en-AU')}.`,
          linkPath: '/maintenance-schedules',
        });
        await tx.assetMaintenancePlan.update({ where: { id: plan.id }, data: { dueAlertedAt: now } });
        due += 1;
      }

      return { due, overdue };
    });
  }

  private nextDueAt(plan: { lastServiceAt: Date | null; createdAt: Date; intervalDays: number }): Date {
    const baseline = plan.lastServiceAt ?? plan.createdAt;
    return new Date(baseline.getTime() + plan.intervalDays * DAY_MS);
  }

  /** Starter presets a customer can seed a template from (basic + heavy). */
  presets() {
    return [
      {
        name: 'Light vehicle basics',
        items: [
          { label: 'Service', intervalDays: 180 },
          { label: 'Safety inspection', intervalDays: 365 },
          { label: 'Registration renewal', intervalDays: 365 },
        ],
      },
      {
        name: 'Heavy vehicle basics',
        items: [
          { label: 'Service', intervalDays: 90 },
          { label: 'Roadworthy / NHVAS inspection', intervalDays: 180 },
          { label: 'Brake & suspension check', intervalDays: 120 },
          { label: 'Registration renewal', intervalDays: 365 },
        ],
      },
    ];
  }

  // ---- Templates ------------------------------------------------------------

  async listTemplates(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.maintenanceScheduleTemplate.findMany({
        where: { archivedAt: null },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { plans: { where: { archivedAt: null } } } } },
      });
      return { items };
    });
  }

  async createTemplate(companyId: string, dto: CreateTemplateDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.isDefault) await this.clearDefault(tx);
      return tx.maintenanceScheduleTemplate.create({
        data: {
          companyId,
          name: dto.name.trim(),
          isDefault: dto.isDefault ?? false,
          items: dto.items as unknown as Prisma.InputJsonValue,
        },
      });
    });
  }

  async updateTemplate(companyId: string, id: string, dto: UpdateTemplateDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireTemplate(tx, companyId, id);
      if (dto.isDefault) await this.clearDefault(tx, id);
      return tx.maintenanceScheduleTemplate.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          isDefault: dto.isDefault,
          items: dto.items ? (dto.items as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
    });
  }

  async archiveTemplate(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const t = await this.requireTemplate(tx, companyId, id);
      if (t.archivedAt) return t;
      return tx.maintenanceScheduleTemplate.update({ where: { id }, data: { archivedAt: new Date(), isDefault: false } });
    });
  }

  /**
   * Deploy a template to assets: materialise one plan per template item per
   * asset. Idempotent per (asset,label) — re-deploying doesn't duplicate an
   * item an asset already has (archived ones are revived).
   */
  async deployTemplate(companyId: string, id: string, dto: DeployTemplateDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const template = await this.requireTemplate(tx, companyId, id);
      const items = (template.items as unknown as ScheduleItem[]) ?? [];
      // Only deploy to assets that actually belong to the tenant and aren't archived.
      const assets = await tx.asset.findMany({ where: { id: { in: dto.assetIds }, companyId, archivedAt: null }, select: { id: true } });

      // Set-based instead of a per-(asset,item) query loop (was O(assets×items)
      // round trips): fetch every relevant existing plan once, then decide
      // revive-vs-create in memory and flush with batched writes — O(items).
      const itemByLabel = new Map(items.map((i) => [i.label, i]));
      const labels = items.map((i) => i.label);
      const assetIds = assets.map((a) => a.id);
      const existing = assetIds.length
        ? await tx.assetMaintenancePlan.findMany({
            where: { assetId: { in: assetIds }, label: { in: labels } },
            select: { id: true, assetId: true, label: true, archivedAt: true },
          })
        : [];
      const existingKeys = new Set(existing.map((e) => `${e.assetId}::${e.label}`));

      // Revive archived matches, grouped by label so it's one updateMany per
      // distinct template item rather than one per plan.
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
        const res = await tx.assetMaintenancePlan.updateMany({
          where: { id: { in: ids } },
          data: { archivedAt: null, intervalDays: item.intervalDays, templateId: id },
        });
        revived += res.count;
      }

      // Create the (asset,item) pairs that have no plan at all, in one insert.
      const toCreate = assets.flatMap((asset) =>
        items
          .filter((item) => !existingKeys.has(`${asset.id}::${item.label}`))
          .map((item) => ({ companyId, assetId: asset.id, templateId: id, label: item.label, intervalDays: item.intervalDays })),
      );
      if (toCreate.length) await tx.assetMaintenancePlan.createMany({ data: toCreate });

      return { assetsTargeted: assets.length, plansCreated: toCreate.length, plansRevived: revived };
    });
  }

  // ---- Per-asset plans ------------------------------------------------------

  /** Every non-archived plan, newest-due first, with derived status. */
  async listAllPlans(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const plans = await tx.assetMaintenancePlan.findMany({
        where: { archivedAt: null },
        include: { asset: { select: { id: true, name: true } } },
      });
      const now = new Date();
      const items = plans
        .map((p) => this.withStatus(p, now))
        .sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime());
      return {
        items,
        overdueCount: items.filter((p) => p.status === 'overdue').length,
        dueSoonCount: items.filter((p) => p.status === 'due_soon').length,
      };
    });
  }

  async listPlansForAsset(companyId: string, assetId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const plans = await tx.assetMaintenancePlan.findMany({ where: { assetId, archivedAt: null } });
      const now = new Date();
      return { items: plans.map((p) => this.withStatus(p, now)).sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime()) };
    });
  }

  async createPlan(companyId: string, dto: CreatePlanDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const asset = await tx.asset.findFirst({ where: { id: dto.assetId, companyId, archivedAt: null } });
      if (!asset) throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
      const plan = await tx.assetMaintenancePlan.create({
        data: {
          companyId,
          assetId: dto.assetId,
          label: dto.label.trim(),
          intervalDays: dto.intervalDays,
          lastServiceAt: dto.lastServiceAt ? new Date(dto.lastServiceAt) : null,
        },
      });
      return this.withStatus(plan, new Date());
    });
  }

  async updatePlan(companyId: string, id: string, dto: UpdatePlanDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requirePlan(tx, companyId, id);
      // Editing the interval or last-service date moves the derived next-due
      // date, so a stale alert mark would wrongly suppress the next cycle's
      // alert — reset both marks to start a fresh alert lifecycle, the same as
      // a renewed compliance document being a new row.
      const dueDateChanged = dto.intervalDays !== undefined || dto.lastServiceAt !== undefined;
      const plan = await tx.assetMaintenancePlan.update({
        where: { id },
        data: {
          label: dto.label?.trim(),
          intervalDays: dto.intervalDays,
          lastServiceAt: dto.lastServiceAt === undefined ? undefined : dto.lastServiceAt ? new Date(dto.lastServiceAt) : null,
          ...(dueDateChanged ? { dueAlertedAt: null, overdueAlertedAt: null } : {}),
        },
      });
      return this.withStatus(plan, new Date());
    });
  }

  /** Mark serviced now — resets the clock (and the alert lifecycle). */
  async servicePlan(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requirePlan(tx, companyId, id);
      const plan = await tx.assetMaintenancePlan.update({
        where: { id },
        data: { lastServiceAt: new Date(), dueAlertedAt: null, overdueAlertedAt: null },
      });
      return this.withStatus(plan, new Date());
    });
  }

  async archivePlan(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const plan = await this.requirePlan(tx, companyId, id);
      if (plan.archivedAt) return this.withStatus(plan, new Date());
      const updated = await tx.assetMaintenancePlan.update({ where: { id }, data: { archivedAt: new Date() } });
      return this.withStatus(updated, new Date());
    });
  }

  // ---- helpers --------------------------------------------------------------

  private withStatus(
    plan: { id: string; assetId: string; label: string; intervalDays: number; lastServiceAt: Date | null; createdAt: Date; asset?: { id: string; name: string } },
    now: Date,
  ) {
    const baseline = plan.lastServiceAt ?? plan.createdAt;
    const nextDueAt = new Date(baseline.getTime() + plan.intervalDays * DAY_MS);
    const daysUntilDue = Math.round((nextDueAt.getTime() - now.getTime()) / DAY_MS);
    const status: PlanStatus = daysUntilDue < 0 ? 'overdue' : daysUntilDue <= DUE_SOON_DAYS ? 'due_soon' : 'ok';
    return {
      id: plan.id,
      assetId: plan.assetId,
      asset: plan.asset,
      label: plan.label,
      intervalDays: plan.intervalDays,
      lastServiceAt: plan.lastServiceAt,
      nextDueAt,
      daysUntilDue,
      status,
    };
  }

  private async clearDefault(tx: Prisma.TransactionClient, exceptId?: string) {
    await tx.maintenanceScheduleTemplate.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }

  private async requireTemplate(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const t = await tx.maintenanceScheduleTemplate.findUnique({ where: { id } });
    if (!t || t.companyId !== companyId) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: 'Schedule template not found.' });
    return t;
  }

  private async requirePlan(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const p = await tx.assetMaintenancePlan.findUnique({ where: { id } });
    if (!p || p.companyId !== companyId) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Maintenance plan not found.' });
    return p;
  }
}
