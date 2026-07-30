import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { OVERRIDABLE_METRICS, OverridableMetric, SetOverrideDto, UpdateAnalyticsSettingsDto } from './dto/analytics.dto';

/** Platform defaults when a company hasn't set its own analytics targets. */
export const DEFAULT_ANALYTICS_SETTINGS = { utilisationTarget: 80, complianceTarget: 95, goodThreshold: 95, warnThreshold: 80 };

/**
 * Analytics controls (analytics:manage): a company can set its own target
 * percentages + colour thresholds, manually override a live dashboard figure
 * (kept transparent — the dashboard marks it "adjusted" and shows the note),
 * exclude an unrepresentative day from the trend/delta, and reset the
 * accumulated history. Every mutating action is written to the security audit
 * trail, so an override or reset is always attributable.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertMetric(metric: string): OverridableMetric {
    if (!(OVERRIDABLE_METRICS as readonly string[]).includes(metric)) {
      throw new BadRequestException({ code: 'ANALYTICS_UNKNOWN_METRIC', message: `Unknown metric "${metric}".` });
    }
    return metric as OverridableMetric;
  }

  /** Targets + thresholds + active overrides — read by the dashboard widgets (analytics:view via assets:view). */
  async getSettings(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const [row, overrides] = await Promise.all([
        tx.analyticsSetting.findUnique({ where: { companyId } }),
        tx.analyticsOverride.findMany({ include: { actorUser: { select: { fullName: true } } } }),
      ]);
      const settings = {
        utilisationTarget: row?.utilisationTarget ?? DEFAULT_ANALYTICS_SETTINGS.utilisationTarget,
        complianceTarget: row?.complianceTarget ?? DEFAULT_ANALYTICS_SETTINGS.complianceTarget,
        goodThreshold: row?.goodThreshold ?? DEFAULT_ANALYTICS_SETTINGS.goodThreshold,
        warnThreshold: row?.warnThreshold ?? DEFAULT_ANALYTICS_SETTINGS.warnThreshold,
        isDefault: !row,
      };
      const overrideMap: Record<string, { value: number; note: string | null; by: string | null; at: Date }> = {};
      for (const o of overrides) overrideMap[o.metric] = { value: o.value, note: o.note, by: o.actorUser?.fullName ?? null, at: o.updatedAt };
      return { settings, overrides: overrideMap };
    });
  }

  async updateSettings(companyId: string, actorUserId: string, dto: UpdateAnalyticsSettingsDto) {
    const good = dto.goodThreshold;
    const warn = dto.warnThreshold;
    if (good !== undefined && warn !== undefined && warn > good) {
      throw new BadRequestException({ code: 'ANALYTICS_THRESHOLD_ORDER', message: 'The amber threshold must be at or below the green threshold.' });
    }
    const result = await this.prisma.withTenant(companyId, (tx) =>
      tx.analyticsSetting.upsert({
        where: { companyId },
        create: { companyId, ...dto },
        update: { ...dto },
      }),
    );
    await this.audit.record(companyId, { actorUserId, action: 'analytics.settings_updated', targetType: 'analytics_settings', metadata: { ...dto } });
    return this.getSettings(companyId);
  }

  async resetSettings(companyId: string, actorUserId: string) {
    await this.prisma.withTenant(companyId, (tx) => tx.analyticsSetting.deleteMany({ where: { companyId } }));
    await this.audit.record(companyId, { actorUserId, action: 'analytics.settings_reset', targetType: 'analytics_settings' });
    return this.getSettings(companyId);
  }

  async setOverride(companyId: string, actorUserId: string, metric: string, dto: SetOverrideDto) {
    const m = this.assertMetric(metric);
    await this.prisma.withTenant(companyId, (tx) =>
      tx.analyticsOverride.upsert({
        where: { companyId_metric: { companyId, metric: m } },
        create: { companyId, metric: m, value: dto.value, note: dto.note?.trim() || null, actorUserId },
        update: { value: dto.value, note: dto.note?.trim() || null, actorUserId },
      }),
    );
    await this.audit.record(companyId, { actorUserId, action: 'analytics.override_set', targetType: 'analytics_override', targetId: m, metadata: { value: dto.value, note: dto.note ?? null } });
    return this.getSettings(companyId);
  }

  async clearOverride(companyId: string, actorUserId: string, metric: string) {
    const m = this.assertMetric(metric);
    await this.prisma.withTenant(companyId, (tx) => tx.analyticsOverride.deleteMany({ where: { metric: m } }));
    await this.audit.record(companyId, { actorUserId, action: 'analytics.override_cleared', targetType: 'analytics_override', targetId: m });
    return this.getSettings(companyId);
  }

  /** Clear the accumulated utilisation snapshots so the trend + deltas rebuild from now. */
  async resetHistory(companyId: string, actorUserId: string) {
    const { count } = await this.prisma.withTenant(companyId, (tx) => tx.utilisationSnapshot.deleteMany({ where: {} }));
    await this.audit.record(companyId, { actorUserId, action: 'analytics.history_reset', targetType: 'utilisation_snapshots', metadata: { deleted: count } });
    return { deleted: count };
  }

  /** Recent snapshot days (incl. excluded ones) for the exclusion management list. */
  async listSnapshots(companyId: string, days: number) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const from = new Date();
      from.setUTCHours(0, 0, 0, 0);
      from.setUTCDate(from.getUTCDate() - (days - 1));
      const rows = await tx.utilisationSnapshot.findMany({ where: { day: { gte: from } }, orderBy: { day: 'desc' } });
      return {
        items: rows.map((r) => ({
          date: r.day.toISOString().slice(0, 10),
          utilisation: r.activeSum > 0 ? Math.round((r.busySum / r.activeSum) * 100) : 0,
          samples: r.sampleCount,
          excluded: r.excluded,
        })),
      };
    });
  }

  async setExclusion(companyId: string, actorUserId: string, date: string, excluded: boolean) {
    const day = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(day.getTime())) throw new BadRequestException({ code: 'ANALYTICS_BAD_DATE', message: 'Expected a YYYY-MM-DD date.' });
    const updated = await this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.utilisationSnapshot.findUnique({ where: { companyId_day: { companyId, day } } });
      if (!existing) throw new NotFoundException({ code: 'ANALYTICS_SNAPSHOT_NOT_FOUND', message: 'No utilisation snapshot for that day.' });
      return tx.utilisationSnapshot.update({ where: { companyId_day: { companyId, day } }, data: { excluded } });
    });
    await this.audit.record(companyId, { actorUserId, action: 'analytics.day_excluded', targetType: 'utilisation_snapshots', targetId: date, metadata: { excluded } });
    return { date, excluded: updated.excluded };
  }
}
