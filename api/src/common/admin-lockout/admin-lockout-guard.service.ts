import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PERMISSIONS } from '../permissions/permission-catalog';

/**
 * Holding both of these is what lets a user recover from any other
 * permission mistake in the company (reassign anyone to any role, or edit
 * a role's permission set directly) — the working definition of
 * "administrative" for lockout-prevention purposes.
 */
const ADMIN_PERMISSIONS: string[] = [PERMISSIONS.ROLES_EDIT, PERMISSIONS.USERS_EDIT];

type MembershipWithRolePermissions = Prisma.CompanyMembershipGetPayload<{
  include: { role: { include: { permissions: { include: { permission: true } } } } };
}>;

/**
 * 14-Security/Permissions_Model.md rough edge (see apps/api/README.md's
 * "Known gaps"): nothing stopped a user removing their own last
 * administrative permission, or editing/archiving the only role capable of
 * managing roles/users, leaving a company with no way to recover short of
 * direct DB access. Call `assertAdminRemains` inside the same transaction
 * as the mutation, passing an `overrideFn` that reports what each
 * membership's permission set WOULD be after the change (return `null` for
 * a membership being deactivated) — if no active membership would hold
 * every admin permission afterward, the mutation is rejected before it
 * commits.
 *
 * Only enforced when the company currently HAS an admin (some active
 * membership holds both permissions right now) — a company that never
 * concentrated roles:edit + users:edit onto any one role (e.g. it manages
 * every role change through some other combination of permissions) isn't
 * missing anything this guard can restore, so every *other*, unrelated
 * membership/role change in that company must not be collaterally blocked
 * by an admin-lockout state this action didn't create — see
 * 01-Product/Onboarding_Decommissioning.md's operator-archive case, which
 * surfaced this: archiving an operator with no admin permissions at all
 * must never fail because some *other* role in the company also lacks them.
 */
@Injectable()
export class AdminLockoutGuardService {
  async assertAdminRemains(
    tx: Prisma.TransactionClient,
    companyId: string,
    overrideFn?: (membership: MembershipWithRolePermissions) => string[] | null,
  ): Promise<void> {
    const memberships = await tx.companyMembership.findMany({
      where: { companyId, archivedAt: null },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });

    const isAdmin = (permissionKeys: string[] | null) =>
      permissionKeys !== null && ADMIN_PERMISSIONS.every((p) => permissionKeys.includes(p));

    const hadAdminBefore = memberships.some((m) => isAdmin(m.role.permissions.map((rp) => rp.permission.key)));
    if (!hadAdminBefore) return;

    const hasAdminAfter = memberships.some((m) =>
      isAdmin(overrideFn ? overrideFn(m) : m.role.permissions.map((rp) => rp.permission.key)),
    );

    if (!hasAdminAfter) {
      throw new ForbiddenException({
        code: 'ADMIN_LOCKOUT',
        message:
          'This change would leave no one in the company able to manage users or roles. Assign another user an administrative role first.',
      });
    }
  }
}
