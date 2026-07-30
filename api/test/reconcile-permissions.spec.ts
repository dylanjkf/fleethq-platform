/**
 * Seed-script permission drift fix: provisionCompany() only computes "every
 * permission" / "every :view permission" once, at company-creation time —
 * this reconciliation is what keeps an existing company's Administrator/Read
 * Only system-template roles in sync with the catalog afterwards.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PERMISSION_CATALOG } from '../src/common/permissions/permission-catalog';
import { provisionCompany } from '../src/companies/provision-company';
import { reconcileSystemRolePermissions } from '../prisma/reconcile-permissions';

const prisma = new PrismaClient();

describe('reconcileSystemRolePermissions', () => {
  beforeAll(async () => {
    for (const entry of PERMISSION_CATALOG) {
      await prisma.permission.upsert({ where: { key: entry.key }, update: {}, create: entry });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('re-grants a permission missing from an existing Administrator/Read Only role, but leaves a custom role alone', async () => {
    const suffix = randomUUID();
    const result = await provisionCompany(prisma, {
      companyName: `Reconcile Test ${suffix}`,
      adminUsername: `reconcile-${suffix}`,
      adminPassword: 'password123',
      adminFullName: 'Test Admin',
    });

    const depotsView = await prisma.permission.findUniqueOrThrow({ where: { key: 'depots:view' } });

    // Simulate drift: this company's roles were provisioned before depots:view
    // existed, so drop it from both system-template roles (and add a custom
    // role that never had it either, to confirm it's untouched).
    await prisma.rolePermission.deleteMany({ where: { roleId: result.administratorRoleId, permissionId: depotsView.id } });
    await prisma.rolePermission.deleteMany({ where: { roleId: result.readOnlyRoleId, permissionId: depotsView.id } });
    const customRole = await prisma.role.create({
      data: { companyId: result.companyId, name: 'Custom Role', isSystemTemplate: false },
    });

    const reconciled = await reconcileSystemRolePermissions(prisma);
    expect(reconciled.permissionsGranted).toBeGreaterThanOrEqual(2);

    const adminHasDepotsView = await prisma.rolePermission.findFirst({
      where: { roleId: result.administratorRoleId, permissionId: depotsView.id },
    });
    expect(adminHasDepotsView).not.toBeNull();

    const readOnlyHasDepotsView = await prisma.rolePermission.findFirst({
      where: { roleId: result.readOnlyRoleId, permissionId: depotsView.id },
    });
    expect(readOnlyHasDepotsView).not.toBeNull();

    // A custom (non-system-template) role never gains permissions it wasn't
    // explicitly given — reconciliation only touches Administrator/Read Only.
    const customRolePermissionCount = await prisma.rolePermission.count({ where: { roleId: customRole.id } });
    expect(customRolePermissionCount).toBe(0);

    // Running it again is idempotent for this company — nothing left to grant.
    const allPermissionsCount = await prisma.permission.count();
    const adminCountAfterFirstRun = await prisma.rolePermission.count({ where: { roleId: result.administratorRoleId } });
    expect(adminCountAfterFirstRun).toBe(allPermissionsCount);

    await reconcileSystemRolePermissions(prisma);
    const adminCountAfterSecondRun = await prisma.rolePermission.count({ where: { roleId: result.administratorRoleId } });
    expect(adminCountAfterSecondRun).toBe(allPermissionsCount);
  });
});
