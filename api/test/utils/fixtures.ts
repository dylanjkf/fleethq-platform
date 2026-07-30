/**
 * Test fixtures connect with the schema-owning role (DATABASE_URL), bypassing
 * RLS deliberately — setting up two isolated tenants to test isolation between
 * has to happen from outside either tenant's context, the same way the seed
 * script does. The tests themselves only ever exercise the real HTTP API with
 * the RLS-constrained runtime role, via `fleetos_app`.
 *
 * Each tenant gets a randomized name/username so parallel test files never
 * collide; nothing is torn down afterward since CI runs these against a
 * throwaway Postgres service container that's discarded when the job ends.
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PERMISSION_CATALOG, PermissionKey } from '../../src/common/permissions/permission-catalog';

const ownerPrisma = new PrismaClient();

export const TEST_PASSWORD = 'test-password-123';

/** The shared built-in categories (company_id = null), used by every test tenant. */
export async function ensureAssetClasses(): Promise<void> {
  for (const key of ['LAND', 'AIR', 'SEA']) {
    const existing = await ownerPrisma.assetClass.findFirst({ where: { companyId: null, key } });
    if (existing) await ownerPrisma.assetClass.update({ where: { id: existing.id }, data: { isImplemented: true } });
    else await ownerPrisma.assetClass.create({ data: { companyId: null, key, name: key, isImplemented: true } });
  }
}

export async function ensurePermissions(): Promise<void> {
  for (const entry of PERMISSION_CATALOG) {
    await ownerPrisma.permission.upsert({
      where: { key: entry.key },
      update: { category: entry.category, description: entry.description },
      create: entry,
    });
  }
}

export interface TestTenant {
  companyId: string;
  userId: string;
  username: string;
}

export async function createTestTenant(permissionKeys: PermissionKey[]): Promise<TestTenant> {
  const suffix = randomUUID();
  const company = await ownerPrisma.company.create({
    data: { name: `Test Co ${suffix}`, jurisdiction: 'AU' },
  });

  const permissions = await ownerPrisma.permission.findMany({
    where: { key: { in: permissionKeys as string[] } },
  });

  const role = await ownerPrisma.role.create({
    data: {
      companyId: company.id,
      name: `Test Role ${suffix}`,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });

  const username = `test-${suffix}`;
  const user = await ownerPrisma.user.create({
    data: {
      username,
      passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      fullName: 'Test User',
    },
  });

  await ownerPrisma.companyMembership.create({
    data: { userId: user.id, companyId: company.id, roleId: role.id },
  });

  return { companyId: company.id, userId: user.id, username };
}

/**
 * Directly links a login-capable Operator to an existing test User (the DriverOS
 * Operator↔User link), bypassing the API so a test can exercise operator-derived
 * behavior — e.g. a checklist submission resolving its operator from the JWT.
 */
export async function createOperatorLinkedToUser(
  companyId: string,
  userId: string,
  fullName = 'Test Operator',
): Promise<string> {
  const operator = await ownerPrisma.operator.create({
    data: { companyId, userId, fullName },
  });
  return operator.id;
}

/**
 * Adds a second login-capable User (with its own Role granting the given
 * permissions) to an EXISTING company — for tests that need more than one user
 * in the same tenant, e.g. verifying a notification fans out to another user.
 */
export async function addUserToCompany(
  companyId: string,
  permissionKeys: PermissionKey[],
  fullName = 'Second User',
  email?: string,
): Promise<{ userId: string; username: string }> {
  const suffix = randomUUID();
  const permissions = await ownerPrisma.permission.findMany({ where: { key: { in: permissionKeys as string[] } } });
  const role = await ownerPrisma.role.create({
    data: {
      companyId,
      name: `Test Role ${suffix}`,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  });
  const username = `test2-${suffix}`;
  const user = await ownerPrisma.user.create({
    data: { username, passwordHash: await bcrypt.hash(TEST_PASSWORD, 10), fullName, email: email ?? null },
  });
  await ownerPrisma.companyMembership.create({ data: { userId: user.id, companyId, roleId: role.id } });
  return { userId: user.id, username };
}

/**
 * Directly inserts a historical OperatorShift row, bypassing the
 * start/end API (which always stamps `now()`) — fatigue rule tests need
 * shifts at specific past times to exercise 24h/7-day rolling windows
 * deterministically.
 */
export async function createShift(
  companyId: string,
  operatorId: string,
  startedAt: Date,
  endedAt: Date | null,
): Promise<string> {
  const shift = await ownerPrisma.operatorShift.create({
    data: { companyId, operatorId, startedAt, endedAt, status: endedAt ? 'ENDED' : 'ACTIVE' },
  });
  return shift.id;
}

export async function disconnectFixtures(): Promise<void> {
  await ownerPrisma.$disconnect();
}
