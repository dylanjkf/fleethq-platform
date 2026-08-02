/**
 * CLI wrapper for the admin-permission reconcile. The actual logic lives in
 * `src/bootstrap/admin-permissions-reconcile.ts` so that `nest build` compiles
 * it into `dist/` and the production boot-time bootstrap can call it inside the
 * deployed container. This file keeps the historical import path
 * (`prisma/reconcile-admin-permissions`) working for the `ts-node` callers
 * (prisma/seed.ts, `npm run admin:permissions:sync`, scripts/bootstrap-admin.ts)
 * and provides the standalone `main()` entrypoint, with no logic duplicated.
 */
import '../scripts/load-env';
import { PrismaClient } from '@prisma/client';
import { reconcileAdminPermissions } from '../src/bootstrap/admin-permissions-reconcile';

export {
  reconcileAdminPermissions,
  SUPER_ADMIN_ROLE_NAME,
  SUPPORT_ROLE_NAME,
  type AdminReconcileResult,
} from '../src/bootstrap/admin-permissions-reconcile';

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
