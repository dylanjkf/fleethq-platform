import { randomUUID } from 'crypto';
import { Prisma, TimelineEntityType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { TimelineService } from '../timeline/timeline.service';
import { DRIVER_ROLE_PERMISSION_KEYS } from '../common/permissions/permission-catalog';

/**
 * The one place a Company, its starting Roles, and its first admin User get
 * created together. Used by both POST /v1/companies (self-service signup)
 * and prisma/seed.ts (local dev bootstrap) so the two can't drift — the
 * seed script existed before signup did, and duplicating this logic between
 * them is exactly the kind of thing that quietly goes stale.
 *
 * Framework-agnostic on purpose: seed.ts has no NestJS DI container, so this
 * takes a plain Prisma client/transaction handle rather than being a
 * `@Injectable()` service.
 */

export interface ProvisionCompanyInput {
  /**
   * Pre-generated so a caller running inside PrismaService.withTenant can set
   * the RLS session GUC to this id *before* the Company row exists — the
   * companies table's own RLS policy requires `id = current_setting(...)`
   * even on INSERT. Callers with no RLS to worry about (the seed script, via
   * the schema-owning role) can omit it and let one be generated here.
   */
  companyId?: string;
  companyName: string;
  jurisdiction?: string;
  adminUsername: string;
  /** Plaintext — hashed here so callers never handle a raw password beyond this call. */
  adminPassword: string;
  adminFullName: string;
  /** Optional contact email for the first admin — the target for a verification link. */
  adminEmail?: string;
  /**
   * Length of the native free trial to grant (days). Self-serve signup passes
   * this so a new company starts on the Trial tier; the seed/dev bootstrap
   * omits it (no trial — dev runs unlimited via BILLING_ENFORCED=false anyway).
   */
  trialDays?: number;
}

export interface ProvisionCompanyResult {
  companyId: string;
  companyName: string;
  administratorRoleId: string;
  readOnlyRoleId: string;
  adminUserId: string;
  adminUsername: string;
  adminMembershipId: string;
}

export async function provisionCompany(
  tx: Prisma.TransactionClient,
  input: ProvisionCompanyInput,
): Promise<ProvisionCompanyResult> {
  const companyId = input.companyId ?? randomUUID();
  const timeline = new TimelineService();

  const company = await tx.company.create({
    data: {
      id: companyId,
      name: input.companyName,
      jurisdiction: input.jurisdiction ?? 'AU',
      trialEndsAt: input.trialDays ? new Date(Date.now() + input.trialDays * 24 * 60 * 60 * 1000) : null,
    },
  });

  const allPermissions = await tx.permission.findMany();
  const viewOnlyPermissions = allPermissions.filter((p) => p.key.endsWith(':view'));

  // Two starting Role Templates — companies can edit or clone either
  // (14-Security/Permissions_Model.md), these are just a usable default so a
  // brand-new company isn't stuck with zero roles to assign.
  const administratorRole = await tx.role.create({
    data: {
      companyId,
      name: 'Administrator',
      description: 'Full access to every capability. Cloneable/editable like any role.',
      isSystemTemplate: true,
      permissions: { create: allPermissions.map((p) => ({ permissionId: p.id })) },
    },
  });

  const readOnlyRole = await tx.role.create({
    data: {
      companyId,
      name: 'Read Only',
      description: 'View-only access across the platform.',
      isSystemTemplate: true,
      permissions: { create: viewOnlyPermissions.map((p) => ({ permissionId: p.id })) },
    },
  });

  // A ready-to-assign role for DriverOS logins, bundling exactly the field
  // actions a driver needs (inspections, forms, deliveries, location, shifts,
  // fuel, and messaging the office). Without this, drivers were given a
  // hand-built or Read-Only-derived role that easily omitted an action like
  // `messages:send`, silently blocking them from replying to the office.
  const driverPermissions = allPermissions.filter((p) =>
    (DRIVER_ROLE_PERMISSION_KEYS as string[]).includes(p.key),
  );
  await tx.role.create({
    data: {
      companyId,
      name: 'Driver',
      description: 'DriverOS field access — inspections, forms, deliveries, location, shifts, fuel and office messaging.',
      isSystemTemplate: true,
      permissions: { create: driverPermissions.map((p) => ({ permissionId: p.id })) },
    },
  });

  // `users` RLS makes visibility depend on an existing CompanyMembership
  // (see the migration comment) — but Prisma's `.create()` always does an
  // `INSERT ... RETURNING`, and Postgres re-checks SELECT visibility on the
  // row being returned. A brand-new user has no membership yet at the exact
  // instant of insertion, so `.create()` here would fail with "new row
  // violates row-level security policy" even though the insert itself is
  // perfectly legitimate. `createMany` has no RETURNING, so it sidesteps the
  // check entirely — found by actually running this against real Postgres,
  // not by inspection.
  const adminUserId = randomUUID();
  await tx.user.createMany({
    data: [
      {
        id: adminUserId,
        username: input.adminUsername,
        passwordHash: await bcrypt.hash(input.adminPassword, 10),
        fullName: input.adminFullName,
        email: input.adminEmail ?? null,
      },
    ],
  });

  const adminMembership = await tx.companyMembership.create({
    data: { userId: adminUserId, companyId, roleId: administratorRole.id },
  });

  await timeline.record(tx, {
    companyId,
    entityType: TimelineEntityType.COMPANY,
    entityId: companyId,
    eventType: 'created',
    summary: `Company "${company.name}" created.`,
    actorUserId: adminUserId,
  });

  await timeline.record(tx, {
    companyId,
    entityType: TimelineEntityType.USER,
    entityId: adminUserId,
    eventType: 'created',
    summary: `User "${input.adminUsername}" created as company administrator.`,
    actorUserId: adminUserId,
  });

  return {
    companyId,
    companyName: company.name,
    administratorRoleId: administratorRole.id,
    readOnlyRoleId: readOnlyRole.id,
    adminUserId,
    adminUsername: input.adminUsername,
    adminMembershipId: adminMembership.id,
  };
}
