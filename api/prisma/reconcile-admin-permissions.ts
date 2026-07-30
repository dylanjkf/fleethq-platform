/**
 * The admin platform's equivalent of reconcile-permissions.ts: seeds
 * `admin_permissions` from ADMIN_PERMISSION_CATALOG and keeps the two
 * system-template AdminRoles (Super Admin, Support — see the schema comment
 * on AdminRole) in sync with it, so a new admin permission added to the
 * catalog is automatically granted to Super Admin (all of them) and to
 * Support (its fixed view/support subset) without anyone remembering to
 * update existing roles by hand.
 *
 * Framework-agnostic (no NestJS DI), connected via the schema-owning
 * DATABASE_URL role — same reasoning as reconcile-permissions.ts. Contains no
 * credentials and creates no AdminUser; it is safe to run in every
 * environment, unattended, as often as needed (called from prisma/seed.ts,
 * and standalone via `npm run admin:permissions:sync`).
 */
import '../scripts/load-env';
import { PrismaClient } from '@prisma/client';
import { ADMIN_PERMISSIONS, ADMIN_PERMISSION_CATALOG, AdminPermissionKey } from '../src/common/permissions/admin-permission-catalog';

export const SUPER_ADMIN_ROLE_NAME = 'Super Admin';
export const SUPPORT_ROLE_NAME = 'Support';

/** Support staff get read access everywhere plus the ability to actually act on support tickets — not billing/feature-flag/admin-user management. */
const SUPPORT_ROLE_PERMISSION_KEYS: AdminPermissionKey[] = [
  ADMIN_PERMISSIONS.ORGANISATIONS_VIEW,
  ADMIN_PERMISSIONS.CUSTOMER_USERS_VIEW,
  ADMIN_PERMISSIONS.CUSTOMER_USERS_MANAGE,
  ADMIN_PERMISSIONS.BILLING_VIEW,
  ADMIN_PERMISSIONS.SUPPORT_VIEW,
  ADMIN_PERMISSIONS.SUPPORT_MANAGE,
  ADMIN_PERMISSIONS.FEATURE_FLAGS_VIEW,
  ADMIN_PERMISSIONS.FLEET_VIEW,
  ADMIN_PERMISSIONS.ANALYTICS_VIEW,
];

export interface AdminReconcileResult {
  permissionsUpserted: number;
  superAdminRoleCreated: boolean;
  supportRoleCreated: boolean;
  permissionsGranted: number;
}

async function ensureRole(
  prisma: PrismaClient,
  name: string,
  description: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.adminRole.findUnique({ where: { name } });
  if (existing) return { id: existing.id, created: false };
  const created = await prisma.adminRole.create({ data: { name, description, isSystemTemplate: true } });
  return { id: created.id, created: true };
}

async function grantMissing(prisma: PrismaClient, roleId: string, targetPermissionIds: string[]): Promise<number> {
  const have = new Set((await prisma.adminRolePermission.findMany({ where: { roleId } })).map((p) => p.permissionId));
  const missing = targetPermissionIds.filter((id) => !have.has(id));
  if (missing.length === 0) return 0;
  await prisma.adminRolePermission.createMany({
    data: missing.map((permissionId) => ({ roleId, permissionId })),
    skipDuplicates: true,
  });
  return missing.length;
}

export async function reconcileAdminPermissions(prisma: PrismaClient): Promise<AdminReconcileResult> {
  for (const entry of ADMIN_PERMISSION_CATALOG) {
    await prisma.adminPermission.upsert({
      where: { key: entry.key },
      update: { category: entry.category, description: entry.description },
      create: entry,
    });
  }
  const allPermissions = await prisma.adminPermission.findMany();
  const supportPermissions = allPermissions.filter((p) =>
    (SUPPORT_ROLE_PERMISSION_KEYS as string[]).includes(p.key),
  );

  const superAdmin = await ensureRole(
    prisma,
    SUPER_ADMIN_ROLE_NAME,
    'Full access to every administration capability, including managing other FleetHQ staff accounts.',
  );
  const support = await ensureRole(
    prisma,
    SUPPORT_ROLE_NAME,
    'Front-line support: view organisations/billing, act on support tickets and customer-user issues — no billing changes, feature-flag edits, or staff management.',
  );

  const permissionsGranted =
    (await grantMissing(prisma, superAdmin.id, allPermissions.map((p) => p.id))) +
    (await grantMissing(prisma, support.id, supportPermissions.map((p) => p.id)));

  return {
    permissionsUpserted: ADMIN_PERMISSION_CATALOG.length,
    superAdminRoleCreated: superAdmin.created,
    supportRoleCreated: support.created,
    permissionsGranted,
  };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await reconcileAdminPermissions(prisma);
    console.log(
      `Upserted ${result.permissionsUpserted} admin permission(s); Super Admin role ${result.superAdminRoleCreated ? 'created' : 'already existed'}; ` +
        `Support role ${result.supportRoleCreated ? 'created' : 'already existed'}; granted ${result.permissionsGranted} missing permission(s).`,
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
