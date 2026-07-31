/**
 * Seed-script permission drift fix: provisionCompany() only computes "every
 * permission" / "every :view permission" once, at company-creation time —
 * this reconciliation is what keeps an existing company's Administrator/Read
 * Only system-template roles in sync with the catalog afterwards.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { DISPATCHER_ROLE_PERMISSION_KEYS, PERMISSION_CATALOG } from '../src/common/permissions/permission-catalog';
import { provisionCompany } from '../src/companies/provision-company';
import { reconcileSystemRolePermissions } from '../prisma/reconcile-permissions';

const prisma = new PrismaClient();

// `reconcileSystemRolePermissions` scans every company in the database once
// per role template — fine at any realistic scale, but this suite's own dev/
// CI database can accumulate a large number of companies across many e2e
// runs over time, and the default 5s-ish Jest timeout isn't enough headroom
// for that. 60s keeps this suite reliable without masking a real regression
// (a genuine perf regression would still show up as this suite getting
// slower release over release, just not as a hard failure here).
jest.setTimeout(90_000);

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

  it('backfills a named role template (Auth/Billing Platform Phase 4) that a company is missing entirely', async () => {
    const suffix = randomUUID();
    const result = await provisionCompany(prisma, {
      companyName: `Reconcile Template Test ${suffix}`,
      adminUsername: `reconcile-template-${suffix}`,
      adminPassword: 'password123',
      adminFullName: 'Test Admin',
    });

    // Simulate a company provisioned before "Dispatcher" existed as a
    // template — no row for that name at all (not merely archived: `Role`
    // has a (companyId, name) unique constraint with no exemption for
    // archived rows, so an archived-but-present role must NOT be treated as
    // "missing" or reconciliation would try to create a duplicate and hit
    // that constraint).
    const dispatcherBefore = await prisma.role.findFirstOrThrow({
      where: { companyId: result.companyId, name: 'Dispatcher', isSystemTemplate: true },
    });
    // RolePermission has no cascade delete off Role (this codebase avoids
    // hard deletes on Timeline-relevant entities) — its rows must go first.
    await prisma.rolePermission.deleteMany({ where: { roleId: dispatcherBefore.id } });
    await prisma.role.delete({ where: { id: dispatcherBefore.id } });

    const reconciled = await reconcileSystemRolePermissions(prisma);
    expect(reconciled.rolesCreated.Dispatcher).toBeGreaterThanOrEqual(1);

    const dispatcherRole = await prisma.role.findFirstOrThrow({
      where: { companyId: result.companyId, name: 'Dispatcher', isSystemTemplate: true, archivedAt: null },
      include: { permissions: { include: { permission: true } } },
    });
    const grantedKeys = new Set(dispatcherRole.permissions.map((rp) => rp.permission.key));
    for (const key of DISPATCHER_ROLE_PERMISSION_KEYS) {
      expect(grantedKeys.has(key)).toBe(true);
    }
  });

  it("does not try to recreate a company's archived role template (would violate the (companyId, name) unique constraint)", async () => {
    const suffix = randomUUID();
    const result = await provisionCompany(prisma, {
      companyName: `Reconcile Archived Template Test ${suffix}`,
      adminUsername: `reconcile-archived-${suffix}`,
      adminPassword: 'password123',
      adminFullName: 'Test Admin',
    });

    await prisma.role.updateMany({
      where: { companyId: result.companyId, name: 'Dispatcher', isSystemTemplate: true },
      data: { archivedAt: new Date() },
    });

    // Must not throw (a naive "missing = no active role" check would try to
    // create a second "Dispatcher" row for this company and violate the
    // unique constraint), and must not resurrect the archived role.
    await expect(reconcileSystemRolePermissions(prisma)).resolves.toBeDefined();

    const dispatcherRoles = await prisma.role.findMany({
      where: { companyId: result.companyId, name: 'Dispatcher', isSystemTemplate: true },
    });
    expect(dispatcherRoles).toHaveLength(1);
    expect(dispatcherRoles[0].archivedAt).not.toBeNull();
  });
});
