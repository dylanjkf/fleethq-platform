import { Prisma } from '@prisma/client';
import { PermissionKey } from './permission-catalog';

/**
 * Does this membership currently hold this permission?
 *
 * One implementation, because there are two legitimately different callers and
 * they must not drift apart:
 *  - `PermissionGuard`, answering "may this request proceed at all?"
 *  - services that make a *second*, conditional check — e.g. KnowledgeService
 *    deciding whether a reader may see drafts, or a bulk upload deciding
 *    whether it may also create knowledge articles. Those can't be expressed as
 *    a single route-level `@RequirePermission`, because the answer changes what
 *    the request does rather than whether it is allowed.
 *
 * Resolved fresh from the database every time, never cached and never read from
 * the JWT, so Permissions_Model.md's rule holds: a permission change takes
 * effect on the next request without a re-login. Archived roles and archived
 * memberships never grant anything.
 */
export async function membershipHasPermission(
  tx: Prisma.TransactionClient,
  membershipId: string,
  permission: PermissionKey,
): Promise<boolean> {
  const granted = await tx.rolePermission.findFirst({
    where: {
      permission: { key: permission },
      role: {
        memberships: { some: { id: membershipId, archivedAt: null } },
        archivedAt: null,
      },
    },
    select: { roleId: true },
  });
  return granted !== null;
}
