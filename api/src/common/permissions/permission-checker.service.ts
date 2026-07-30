import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionKey } from './permission-catalog';

/**
 * The same "does this membership have permission X" check `PermissionGuard`
 * uses, extracted for callers that need to branch on a permission *inside*
 * application logic rather than reject a whole route for missing it — e.g.
 * Fleet Health Score including or omitting a factor depending on whether the
 * caller can see the underlying Maintenance/Compliance data at all.
 */
@Injectable()
export class PermissionCheckerService {
  constructor(private readonly prisma: PrismaService) {}

  async hasPermission(companyId: string, membershipId: string, key: PermissionKey): Promise<boolean> {
    const granted = await this.getGrantedKeys(companyId, membershipId, [key]);
    return granted.has(key);
  }

  /**
   * Batched form of hasPermission for callers that need to branch on several
   * keys at once (e.g. Fleet Health's per-factor gating) — one transaction
   * and one query instead of one round trip per key. Load testing (task
   * #110) found the naive N-calls-to-hasPermission version of Fleet Health
   * throttled to a fraction of every other endpoint's throughput under
   * concurrent load purely from extra transaction round trips, not query cost.
   */
  async getGrantedKeys(
    companyId: string,
    membershipId: string,
    keys: PermissionKey[],
  ): Promise<Set<PermissionKey>> {
    const granted = await this.prisma.withTenant(companyId, (tx) =>
      tx.rolePermission.findMany({
        where: {
          permission: { key: { in: keys } },
          role: {
            memberships: { some: { id: membershipId, archivedAt: null } },
            archivedAt: null,
          },
        },
        select: { permission: { select: { key: true } } },
      }),
    );
    return new Set(granted.map((rp) => rp.permission.key as PermissionKey));
  }
}
