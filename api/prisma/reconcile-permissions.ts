/**
 * Closes the "seed-script permission drift" gap: every new permission this
 * codebase has added (depots:*, shifts:*, timeline:view, ...) required
 * someone to remember to re-grant it to existing companies' system-template
 * roles by hand via the Roles UI. provisionCompany() only computes each
 * template's permission set once, at company-creation time — nothing kept
 * existing companies' roles in sync with the catalog afterwards.
 *
 * Generalized over `ROLE_TEMPLATES` (Auth/Billing Platform Phase 4's named
 * role templates) rather than one hand-written block per role name: an
 * existing company missing a template entirely (e.g. it was provisioned
 * before "Dispatcher" existed) gets it created; an existing role of that
 * name missing a permission the template has since gained gets it granted.
 * Never touches a company's own custom (non-system-template) roles.
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
import { ROLE_TEMPLATES } from '../src/common/permissions/permission-catalog';
import { resolveTemplatePermissions } from '../src/companies/provision-company';

export interface ReconcileResult {
  /** Roles created (backfilled), keyed by template name. */
  rolesCreated: Record<string, number>;
  permissionsGranted: number;
}

/**
 * Batch size for the (role × permission) cross-product `createMany` calls
 * below — keeps each query's bind-parameter count (2 per row) comfortably
 * under Postgres's ~65535 limit even across a large fleet of tenants, e.g.
 * thousands of companies × dozens of permissions in the Administrator
 * template.
 */
const GRANT_BATCH_SIZE = 5000;

export async function reconcileSystemRolePermissions(prisma: PrismaClient): Promise<ReconcileResult> {
  const allPermissions = await prisma.permission.findMany();
  const viewOnlyPermissions = allPermissions.filter((p) => p.key.endsWith(':view'));
  const companies = await prisma.company.findMany({ select: { id: true } });

  let permissionsGranted = 0;
  const rolesCreated: Record<string, number> = {};

  for (const template of ROLE_TEMPLATES) {
    const targetPermissions = resolveTemplatePermissions(template.permissionKeys, allPermissions, viewOnlyPermissions);

    // Only role/company ids — never each role's current permission set. A
    // per-role `include: { permissions: true }` (or a per-role `createMany`
    // call to grant what's missing) was the previous implementation's real
    // cost: an N+1 round-trip per existing role, which stops scaling once a
    // fleet reaches thousands of tenants. Instead, always attempt to insert
    // every (role × target permission) pair with `skipDuplicates` — Postgres
    // silently no-ops the ones a role already has, and the returned `count`
    // is exactly how many were actually missing, all in one (batched) query.
    //
    // Fetched without an `isSystemTemplate`/`archivedAt` filter on purpose:
    // `Role`'s `(companyId, name)` unique constraint applies to every role
    // regardless of either flag. A company that renamed/archived its own
    // system-template role, or that simply has its own custom role that
    // happens to share this template's name (e.g. an Administrator picked
    // "Dispatcher" for a hand-built role before this template existed),
    // still isn't "missing" the name — attempting to create a fresh row
    // would violate the constraint either way. Only permission grants below
    // are scoped to active system-template roles; "does this company
    // already have a row with this name at all" uses the fully unfiltered set.
    const rolesWithName = await prisma.role.findMany({
      where: { name: template.name },
      select: { id: true, companyId: true, archivedAt: true, isSystemTemplate: true },
    });
    const activeSystemRoles = rolesWithName.filter((r) => r.isSystemTemplate && !r.archivedAt);
    if (activeSystemRoles.length > 0) {
      const pairs = activeSystemRoles.flatMap((r) => targetPermissions.map((p) => ({ roleId: r.id, permissionId: p.id })));
      permissionsGranted += await createManyChunked(prisma, pairs);
    }

    // Bulk-create in two queries (roles, then their permissions) rather than
    // a per-company round-trip, so this stays fast even across a large fleet
    // of tenants.
    const companiesWithRole = new Set(rolesWithName.map((r) => r.companyId));
    const missingCompanies = companies.filter((c) => !companiesWithRole.has(c.id));
    if (missingCompanies.length > 0) {
      const newRoles = missingCompanies.map((c) => ({ id: randomUUID(), companyId: c.id }));
      await prisma.role.createMany({
        data: newRoles.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          name: template.name,
          description: template.description,
          isSystemTemplate: true,
        })),
      });
      const newPairs = newRoles.flatMap((r) => targetPermissions.map((p) => ({ roleId: r.id, permissionId: p.id })));
      await createManyChunked(prisma, newPairs);
    }
    rolesCreated[template.name] = missingCompanies.length;
  }

  return { rolesCreated, permissionsGranted };
}

/** `rolePermission.createMany({ skipDuplicates: true })`, chunked to stay under the bind-parameter limit; returns the total actually-inserted row count. */
async function createManyChunked(prisma: PrismaClient, pairs: { roleId: string; permissionId: string }[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < pairs.length; i += GRANT_BATCH_SIZE) {
    const { count } = await prisma.rolePermission.createMany({
      data: pairs.slice(i, i + GRANT_BATCH_SIZE),
      skipDuplicates: true,
    });
    inserted += count;
  }
  return inserted;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await reconcileSystemRolePermissions(prisma);
    const createdSummary = Object.entries(result.rolesCreated)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ');
    console.log(
      `Reconciled ${ROLE_TEMPLATES.length} role template(s); ` +
        `created ${createdSummary || 'no'} missing role(s); granted ${result.permissionsGranted} missing permission(s).`,
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
