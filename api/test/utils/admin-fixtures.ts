/**
 * Admin-platform test fixtures. Connects with the schema-owning role
 * (DATABASE_URL) rather than ADMIN_DATABASE_URL — plain owner access is
 * enough to set up rows directly, the same reasoning as fixtures.ts for the
 * customer tables; tests exercise the real HTTP API (which uses
 * fleetos_admin) rather than this connection.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { ADMIN_PERMISSION_CATALOG, AdminPermissionKey } from '../../src/common/permissions/admin-permission-catalog';

const ownerPrisma = new PrismaClient();

export const TEST_ADMIN_PASSWORD = 'test-admin-password-123';

export async function ensureAdminPermissions(): Promise<void> {
  for (const entry of ADMIN_PERMISSION_CATALOG) {
    await ownerPrisma.adminPermission.upsert({
      where: { key: entry.key },
      update: { category: entry.category, description: entry.description },
      create: entry,
    });
  }
}

export interface TestAdmin {
  adminUserId: string;
  username: string;
  roleId: string;
}

export async function createTestAdmin(permissionKeys: AdminPermissionKey[]): Promise<TestAdmin> {
  const suffix = randomUUID();
  const permissions = await ownerPrisma.adminPermission.findMany({ where: { key: { in: permissionKeys as string[] } } });
  const role = await ownerPrisma.adminRole.create({
    data: {
      name: `Test Admin Role ${suffix}`,
      description: 'Fixture role for e2e tests.',
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
  const username = `test-admin-${suffix}`;
  const user = await ownerPrisma.adminUser.create({
    data: {
      username,
      email: `${username}@fleethq.internal`,
      passwordHash: await bcrypt.hash(TEST_ADMIN_PASSWORD, 10),
      fullName: 'Test Admin',
      roleId: role.id,
    },
  });
  return { adminUserId: user.id, username, roleId: role.id };
}

export async function disconnectAdminFixtures(): Promise<void> {
  await ownerPrisma.$disconnect();
}
