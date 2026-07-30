import { AdminPrismaService } from '../../prisma/admin-prisma.service';
import { AdminPermissionKey } from './admin-permission-catalog';

/**
 * Does this admin role currently hold this permission? Resolved fresh from
 * the database on every call — never cached, never read from the JWT — so a
 * role-permission change (or a reassigned role) takes effect on an admin's
 * very next request, matching the customer platform's `membershipHasPermission`
 * contract.
 */
export async function adminRoleHasPermission(
  adminPrisma: AdminPrismaService,
  roleId: string,
  permission: AdminPermissionKey,
): Promise<boolean> {
  const granted = await adminPrisma.adminRolePermission.findFirst({
    where: { roleId, permission: { key: permission } },
    select: { id: true },
  });
  return granted !== null;
}
