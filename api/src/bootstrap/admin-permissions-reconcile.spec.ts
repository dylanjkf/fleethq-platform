/**
 * Round 5 Critical #2 — the destructive-path safety guard on
 * `reconcileAdminPermissions`, plus proof the guard doesn't break the normal
 * retirement path.
 *
 * The function deletes every AdminPermission row NOT in ADMIN_PERMISSION_CATALOG
 * (cascading through the AdminRolePermission FK to strip role grants). An empty
 * catalog would therefore delete ALL of them. These tests pin both halves:
 *   1. an empty catalog throws and deletes nothing;
 *   2. with a real, non-empty catalog a genuinely-removed key is deleted while a
 *      still-present key is left untouched.
 */
import { ADMIN_PERMISSIONS } from '../common/permissions/admin-permission-catalog';
import { reconcileAdminPermissions } from './admin-permissions-reconcile';

const CATALOG_MODULE = '../common/permissions/admin-permission-catalog';

afterEach(() => {
  // The empty-catalog test registers a module mock via jest.doMock; clear it so
  // the retirement-path test below re-requires the module with the REAL catalog.
  jest.dontMock(CATALOG_MODULE);
  jest.resetModules();
});

/** A prisma test double covering exactly the calls reconcileAdminPermissions makes. */
function makePrisma(allPermissions: Array<{ id: string; key: string }>) {
  const deleteMany = jest.fn(async (args: { where: { id: { in: string[] } } }) => ({
    count: args.where.id.in.length,
  }));
  return {
    deleteMany,
    prisma: {
      adminPermission: {
        upsert: jest.fn(async () => undefined),
        findMany: jest.fn(async () => allPermissions),
        deleteMany,
      },
      adminRole: {
        findUnique: jest.fn(async ({ where }: { where: { name: string } }) => ({
          id: `role-${where.name}`,
        })),
        create: jest.fn(async () => ({ id: 'role-new' })),
      },
      adminRolePermission: {
        findMany: jest.fn(async () => []),
        createMany: jest.fn(async () => ({ count: 0 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
    } as never,
  };
}

describe('reconcileAdminPermissions — empty-catalog safety guard (R5 C2)', () => {
  it('throws and deletes NOTHING when the catalog is empty', async () => {
    // Load the module with the catalog import forced empty — the broken-build
    // scenario. `jest.requireActual` keeps ADMIN_PERMISSIONS real so only the
    // list under test is emptied.
    let reconcile!: typeof import('./admin-permissions-reconcile').reconcileAdminPermissions;
    jest.isolateModules(() => {
      jest.doMock(CATALOG_MODULE, () => ({
        ...jest.requireActual(CATALOG_MODULE),
        ADMIN_PERMISSION_CATALOG: [],
      }));
      // A dynamic require is the only way to pick up the doMock'd catalog in an
      // isolated module registry; the rule is disabled for this one line only.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      reconcile = require('./admin-permissions-reconcile').reconcileAdminPermissions;
    });

    const { prisma, deleteMany } = makePrisma([
      { id: 'p1', key: 'organisations:view' },
      { id: 'p2', key: 'billing:view' },
    ]);

    await expect(reconcile(prisma)).rejects.toThrow(/ADMIN_PERMISSION_CATALOG is empty/i);
    // The crucial assertion: it refused BEFORE any destructive call.
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe('reconcileAdminPermissions — normal retirement path still works with the guard (R5 C2)', () => {
  it('deletes a key that fell out of the catalog and leaves a still-present key untouched', async () => {
    // Real (non-empty) catalog via the static top-level import. The DB is
    // reported as holding one genuinely retired permission plus one still present.
    const presentKey = ADMIN_PERMISSIONS.ORGANISATIONS_VIEW; // definitely in the real catalog
    const { prisma, deleteMany } = makePrisma([
      { id: 'p-present', key: presentKey },
      { id: 'p-retired', key: 'totally:removed-from-catalog' },
    ]);

    const result = await reconcileAdminPermissions(prisma);

    // Exactly the retired row is deleted; the present one is not.
    expect(deleteMany).toHaveBeenCalledTimes(1);
    const deletedIds: string[] = deleteMany.mock.calls[0][0].where.id.in;
    expect(deletedIds).toEqual(['p-retired']);
    expect(deletedIds).not.toContain('p-present');
    expect(result.permissionsRetired).toBe(1);
  });
});
