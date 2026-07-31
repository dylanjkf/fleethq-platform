import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Customer-facing evaluation of admin-managed feature flags
 * (21-Admin-Platform/Overview.md, Phase 5b) — the read half of the
 * admin platform's flag CRUD. `feature_flags` has no RLS (global, like
 * `announcements`); `feature_flag_overrides` DOES, so its lookup goes
 * through `PrismaService.withTenant` like any other tenant-scoped read.
 *
 * A flag key that doesn't exist yet fails OPEN (returns enabled) rather than
 * blocking the route — a `FeatureFlagGuard`-gated endpoint must keep working
 * normally until an admin actually creates and disables the flag; it should
 * never break because nobody's created the row yet.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(key: string, companyId: string): Promise<boolean> {
    const flag = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!flag) return true;
    const override = await this.prisma.withTenant(companyId, (tx) =>
      tx.featureFlagOverride.findUnique({ where: { flagId_companyId: { flagId: flag.id, companyId } } }),
    );
    return override ? override.enabled : flag.globalEnabled;
  }

  /** The evaluated state of every known flag for this company — for a client to consult once per session. */
  async getAllForCompany(companyId: string): Promise<Record<string, boolean>> {
    const flags = await this.prisma.featureFlag.findMany();
    if (flags.length === 0) return {};
    const overrides = await this.prisma.withTenant(companyId, (tx) =>
      tx.featureFlagOverride.findMany({ where: { flagId: { in: flags.map((f) => f.id) } } }),
    );
    const overrideByFlagId = new Map(overrides.map((o) => [o.flagId, o.enabled]));
    return Object.fromEntries(flags.map((f) => [f.key, overrideByFlagId.get(f.id) ?? f.globalEnabled]));
  }
}
