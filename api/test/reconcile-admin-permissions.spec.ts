/**
 * The admin platform's equivalent of reconcile-permissions.spec.ts: confirms
 * a permission added to ADMIN_PERMISSION_CATALOG after Super Admin/Support
 * were created gets granted where it should (Super Admin: always; Support:
 * only if it's in the fixed subset) — and that re-running is idempotent.
 */
import { PrismaClient } from '@prisma/client';
import { ADMIN_PERMISSIONS } from '../src/common/permissions/admin-permission-catalog';
import { reconcileAdminPermissions, SUPER_ADMIN_ROLE_NAME, SUPPORT_ROLE_NAME } from '../prisma/reconcile-admin-permissions';

const prisma = new PrismaClient();

describe('reconcileAdminPermissions', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the Super Admin and Support system-template roles with the right permissions, and stays idempotent', async () => {
    const first = await reconcileAdminPermissions(prisma);
    expect(first.permissionsUpserted).toBeGreaterThan(0);

    const superAdmin = await prisma.adminRole.findUniqueOrThrow({
      where: { name: SUPER_ADMIN_ROLE_NAME },
      include: { permissions: true },
    });
    const support = await prisma.adminRole.findUniqueOrThrow({
      where: { name: SUPPORT_ROLE_NAME },
      include: { permissions: true },
    });
    expect(superAdmin.isSystemTemplate).toBe(true);
    expect(support.isSystemTemplate).toBe(true);

    const allPermissionCount = await prisma.adminPermission.count();
    expect(superAdmin.permissions.length).toBe(allPermissionCount);
    // Support never gets billing:manage or admin_users:manage.
    const billingManage = await prisma.adminPermission.findUniqueOrThrow({ where: { key: ADMIN_PERMISSIONS.BILLING_MANAGE } });
    const supportHasBillingManage = support.permissions.some((p) => p.permissionId === billingManage.id);
    expect(supportHasBillingManage).toBe(false);
    // But Support does get organisations:view.
    const orgsView = await prisma.adminPermission.findUniqueOrThrow({ where: { key: ADMIN_PERMISSIONS.ORGANISATIONS_VIEW } });
    const supportHasOrgsView = support.permissions.some((p) => p.permissionId === orgsView.id);
    expect(supportHasOrgsView).toBe(true);

    // Simulate drift: drop one permission from Super Admin, confirm re-running restores it.
    await prisma.adminRolePermission.deleteMany({ where: { roleId: superAdmin.id, permissionId: orgsView.id } });
    const second = await reconcileAdminPermissions(prisma);
    expect(second.permissionsGranted).toBeGreaterThanOrEqual(1);
    expect(second.superAdminRoleCreated).toBe(false);
    expect(second.supportRoleCreated).toBe(false);

    const superAdminAfter = await prisma.adminRolePermission.count({ where: { roleId: superAdmin.id } });
    expect(superAdminAfter).toBe(allPermissionCount);

    // A third run with nothing missing grants zero.
    const third = await reconcileAdminPermissions(prisma);
    expect(third.permissionsGranted).toBe(0);
  });
});
