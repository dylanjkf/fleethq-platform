import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';
import { CreateFeatureFlagDto } from './dto/create-feature-flag.dto';
import { UpdateFeatureFlagDto } from './dto/update-feature-flag.dto';

/**
 * Admin CRUD for the rollout flags `FeatureFlagsService`/`FeatureFlagGuard`
 * evaluate on the customer side (21-Admin-Platform/Overview.md, Phase 5b).
 * Not created by seed data — a flag only exists once an admin creates it
 * here, and every route gated by `@RequireFeatureFlag` treats a missing flag
 * as enabled (see FeatureFlagsService's own docstring), so creating a flag
 * is always a safe, additive action, never a surprise outage.
 */
@Injectable()
export class AdminFeatureFlagsService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async list() {
    return this.adminPrisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  private async requireFlag(id: string) {
    const flag = await this.adminPrisma.featureFlag.findUnique({ where: { id } });
    if (!flag) throw new NotFoundException({ code: 'FEATURE_FLAG_NOT_FOUND', message: 'Feature flag not found.' });
    return flag;
  }

  async create(dto: CreateFeatureFlagDto, context: AdminActionContext) {
    let flag;
    try {
      flag = await this.adminPrisma.featureFlag.create({
        data: { key: dto.key, name: dto.name, description: dto.description, globalEnabled: dto.globalEnabled ?? true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'FEATURE_FLAG_KEY_TAKEN', message: 'A feature flag with that key already exists.' });
      }
      throw err;
    }
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.FEATURE_FLAG_CREATED,
      entityType: 'feature_flag',
      entityId: flag.id,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { key: flag.key, globalEnabled: flag.globalEnabled },
    });
    return flag;
  }

  async update(id: string, dto: UpdateFeatureFlagDto, context: AdminActionContext) {
    const before = await this.requireFlag(id);
    const flag = await this.adminPrisma.featureFlag.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.globalEnabled !== undefined ? { globalEnabled: dto.globalEnabled } : {}),
      },
    });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.FEATURE_FLAG_UPDATED,
      entityType: 'feature_flag',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { globalEnabled: before.globalEnabled },
      afterValue: { globalEnabled: flag.globalEnabled },
    });
    return flag;
  }

  async remove(id: string, context: AdminActionContext) {
    const flag = await this.requireFlag(id);
    await this.adminPrisma.featureFlag.delete({ where: { id } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.FEATURE_FLAG_DELETED,
      entityType: 'feature_flag',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { key: flag.key },
    });
  }

  /** Every known flag plus this organisation's effective state (override, if any, else the global default). */
  async listForOrganisation(companyId: string) {
    const [flags, overrides] = await Promise.all([
      this.adminPrisma.featureFlag.findMany({ orderBy: { key: 'asc' } }),
      this.adminPrisma.featureFlagOverride.findMany({ where: { companyId } }),
    ]);
    const overrideByFlagId = new Map(overrides.map((o) => [o.flagId, o.enabled]));
    return flags.map((f) => ({
      id: f.id,
      key: f.key,
      name: f.name,
      description: f.description,
      globalEnabled: f.globalEnabled,
      override: overrideByFlagId.has(f.id) ? overrideByFlagId.get(f.id) : null,
      effective: overrideByFlagId.get(f.id) ?? f.globalEnabled,
    }));
  }

  private async requireFlagByKey(key: string) {
    const flag = await this.adminPrisma.featureFlag.findUnique({ where: { key } });
    if (!flag) throw new NotFoundException({ code: 'FEATURE_FLAG_NOT_FOUND', message: 'Feature flag not found.' });
    return flag;
  }

  async setOverride(companyId: string, flagKey: string, enabled: boolean, context: AdminActionContext) {
    const flag = await this.requireFlagByKey(flagKey);
    const override = await this.adminPrisma.featureFlagOverride.upsert({
      where: { flagId_companyId: { flagId: flag.id, companyId } },
      create: { flagId: flag.id, companyId, enabled },
      update: { enabled },
    });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.FEATURE_FLAG_OVERRIDE_SET,
      entityType: 'feature_flag',
      entityId: flag.id,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { key: flag.key, enabled },
    });
    return override;
  }

  async clearOverride(companyId: string, flagKey: string, context: AdminActionContext) {
    const flag = await this.requireFlagByKey(flagKey);
    await this.adminPrisma.featureFlagOverride.deleteMany({ where: { flagId: flag.id, companyId } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.FEATURE_FLAG_OVERRIDE_CLEARED,
      entityType: 'feature_flag',
      entityId: flag.id,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }
}
