import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DASHBOARD_WIDGETS } from './dashboard-widgets';
import { CreatePresetDto, DeployPresetDto, SetLayoutDto, UpdatePresetDto, WidgetSlotDto } from './dto/dashboard-layout.dto';

type WidgetSlot = { key: string; visible: boolean };

/**
 * Dashboard layouts (Saved Layout): a member arranges their own dashboard
 * (which widgets, in what order), and an admin can save an arrangement as a
 * named preset and deploy it to many members' dashboards at once.
 */
@Injectable()
export class DashboardLayoutsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The widget catalog + the caller's current layout (defaulted if unset). */
  async getMyLayout(companyId: string, membershipId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const membership = await tx.companyMembership.findUnique({ where: { id: membershipId }, select: { dashboardLayout: true } });
      const layout = this.normalize((membership?.dashboardLayout as WidgetSlot[] | null) ?? null);
      return { widgets: layout, catalog: DASHBOARD_WIDGETS };
    });
  }

  async setMyLayout(companyId: string, membershipId: string, dto: SetLayoutDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const widgets = this.normalize(dto.widgets);
      await tx.companyMembership.update({ where: { id: membershipId }, data: { dashboardLayout: widgets as unknown as Prisma.InputJsonValue } });
      return { widgets };
    });
  }

  async listPresets(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.dashboardLayoutPreset.findMany({ where: { archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
      return { items };
    });
  }

  async createPreset(companyId: string, dto: CreatePresetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.isDefault) await this.clearDefault(tx);
      return tx.dashboardLayoutPreset.create({
        data: { companyId, name: dto.name.trim(), isDefault: dto.isDefault ?? false, widgets: this.normalize(dto.widgets) as unknown as Prisma.InputJsonValue },
      });
    });
  }

  async updatePreset(companyId: string, id: string, dto: UpdatePresetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requirePreset(tx, companyId, id);
      if (dto.isDefault) await this.clearDefault(tx, id);
      return tx.dashboardLayoutPreset.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          isDefault: dto.isDefault,
          widgets: dto.widgets ? (this.normalize(dto.widgets) as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
    });
  }

  async archivePreset(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const preset = await this.requirePreset(tx, companyId, id);
      if (preset.archivedAt) return preset;
      return tx.dashboardLayoutPreset.update({ where: { id }, data: { archivedAt: new Date(), isDefault: false } });
    });
  }

  /** Deploy: push this preset's arrangement onto the target members' dashboards. */
  async deployPreset(companyId: string, id: string, dto: DeployPresetDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const preset = await this.requirePreset(tx, companyId, id);
      const widgets = this.normalize(preset.widgets as WidgetSlot[]);
      const memberships = await tx.companyMembership.findMany({
        where: { companyId, userId: { in: dto.userIds }, archivedAt: null },
        select: { id: true },
      });
      if (memberships.length === 0) return { applied: 0 };
      const res = await tx.companyMembership.updateMany({
        where: { id: { in: memberships.map((m) => m.id) } },
        data: { dashboardLayout: widgets as unknown as Prisma.InputJsonValue },
      });
      return { applied: res.count };
    });
  }

  /**
   * Normalize a layout to the full widget catalog: keep the caller's order and
   * visibility for known keys, drop unknown ones, and append any catalog widget
   * the layout is missing (default visible) — so a new widget shipping never
   * leaves an old saved layout unable to show it.
   */
  private normalize(input: WidgetSlot[] | null): WidgetSlot[] {
    const known = new Set<string>(DASHBOARD_WIDGETS.map((w) => w.key));
    const seen = new Set<string>();
    const ordered: WidgetSlot[] = [];
    for (const slot of input ?? []) {
      if (known.has(slot.key) && !seen.has(slot.key)) {
        ordered.push({ key: slot.key, visible: !!slot.visible });
        seen.add(slot.key);
      }
    }
    for (const w of DASHBOARD_WIDGETS) {
      if (!seen.has(w.key)) ordered.push({ key: w.key, visible: true });
    }
    return ordered;
  }

  private async clearDefault(tx: Prisma.TransactionClient, exceptId?: string) {
    await tx.dashboardLayoutPreset.updateMany({
      where: { isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) },
      data: { isDefault: false },
    });
  }

  private async requirePreset(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const preset = await tx.dashboardLayoutPreset.findUnique({ where: { id } });
    if (!preset || preset.companyId !== companyId) {
      throw new NotFoundException({ code: 'DASHBOARD_PRESET_NOT_FOUND', message: 'Dashboard layout preset not found.' });
    }
    return preset;
  }
}

// Re-export for callers that only need the slot type.
export type { WidgetSlotDto };
