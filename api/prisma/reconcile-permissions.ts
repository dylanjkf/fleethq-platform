/**
 * Closes the "seed-script permission drift" gap: every new permission this
 * codebase has added (depots:*, shifts:*, timeline:view, ...) required
 * someone to remember to re-grant it to existing companies' Administrator
 * role by hand via the Roles UI. provisionCompany() only computes "every
 * permission" / "every :view permission" once, at company-creation time —
 * nothing kept those two system-template roles in sync with the catalog
 * afterwards.
 *
 * Framework-agnostic on purpose (same reasoning as provision-company.ts):
 * runs as the schema-owning DB role, no NestJS DI container needed, callable
 * from prisma/seed.ts (local dev, every run) and standalone via
 * `npm run permissions:sync` (a deploy-time step after any release that adds
 * a permission — see apps/api/README.md).
 */
import '../scripts/load-env';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { DRIVER_ROLE_PERMISSION_KEYS } from '../src/common/permissions/permission-catalog';

export interface ReconcileResult {
  administratorRolesChecked: number;
  readOnlyRolesChecked: number;
  driverRolesCreated: number;
  permissionsGranted: number;
}

export async function reconcileSystemRolePermissions(prisma: PrismaClient): Promise<ReconcileResult> {
  const allPermissions = await prisma.permission.findMany();
  const viewOnlyPermissions = allPermissions.filter((p) => p.key.endsWith(':view'));
  const driverPermissions = allPermissions.filter((p) =>
    (DRIVER_ROLE_PERMISSION_KEYS as string[]).includes(p.key),
  );

  const administratorRoles = await prisma.role.findMany({
    where: { isSystemTemplate: true, name: 'Administrator', archivedAt: null },
    include: { permissions: true },
  });
  const readOnlyRoles = await prisma.role.findMany({
    where: { isSystemTemplate: true, name: 'Read Only', archivedAt: null },
    include: { permissions: true },
  });

  let permissionsGranted = 0;
  permissionsGranted += await grantMissing(prisma, administratorRoles, allPermissions);
  permissionsGranted += await grantMissing(prisma, readOnlyRoles, viewOnlyPermissions);

  // The "Driver" system role was added after some companies were provisioned,
  // so create it wherever it's missing and keep existing ones in sync — the
  // same drift guard as above, extended to the DriverOS role that fixes drivers
  // being unable to message the office (missing messages:send).
  const companies = await prisma.company.findMany({ select: { id: true } });
  const driverRoles = await prisma.role.findMany({
    where: { isSystemTemplate: true, name: 'Driver', archivedAt: null },
    include: { permissions: true },
  });
  const companiesWithDriverRole = new Set(driverRoles.map((r) => r.companyId));

  // Bulk-create in two queries (roles, then their permissions) rather than a
  // per-company round-trip, so this stays fast even across a large fleet of
  // tenants.
  const missingCompanies = companies.filter((c) => !companiesWithDriverRole.has(c.id));
  if (missingCompanies.length > 0) {
    const newRoles = missingCompanies.map((c) => ({ id: randomUUID(), companyId: c.id }));
    await prisma.role.createMany({
      data: newRoles.map((r) => ({
        id: r.id,
        companyId: r.companyId,
        name: 'Driver',
        description:
          'DriverOS field access — inspections, forms, deliveries, location, shifts, fuel and office messaging.',
        isSystemTemplate: true,
      })),
    });
    await prisma.rolePermission.createMany({
      data: newRoles.flatMap((r) => driverPermissions.map((p) => ({ roleId: r.id, permissionId: p.id }))),
      skipDuplicates: true,
    });
  }
  const driverRolesCreated = missingCompanies.length;
  permissionsGranted += await grantMissing(prisma, driverRoles, driverPermissions);

  return {
    administratorRolesChecked: administratorRoles.length,
    readOnlyRolesChecked: readOnlyRoles.length,
    driverRolesCreated,
    permissionsGranted,
  };
}

async function grantMissing(
  prisma: PrismaClient,
  roles: { id: string; permissions: { permissionId: string }[] }[],
  targetPermissions: { id: string }[],
): Promise<number> {
  let granted = 0;
  for (const role of roles) {
    const have = new Set(role.permissions.map((p) => p.permissionId));
    const missing = targetPermissions.filter((p) => !have.has(p.id));
    if (missing.length === 0) continue;
    await prisma.rolePermission.createMany({
      data: missing.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    granted += missing.length;
  }
  return granted;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await reconcileSystemRolePermissions(prisma);
    console.log(
      `Checked ${result.administratorRolesChecked} Administrator role(s) and ${result.readOnlyRolesChecked} Read Only role(s); ` +
        `created ${result.driverRolesCreated} Driver role(s); granted ${result.permissionsGranted} missing permission(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
