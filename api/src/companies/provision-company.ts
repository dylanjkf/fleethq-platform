import { randomUUID } from 'crypto';
import { Permission, Prisma, TimelineEntityType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { resolveBcryptCost } from '../common/security/bcrypt-cost';
import { TimelineService } from '../timeline/timeline.service';
import { ROLE_TEMPLATES } from '../common/permissions/permission-catalog';

/** Resolves one template's permission spec against the live catalog — shared with reconcile-permissions.ts so "ALL"/"VIEW_ONLY" always mean the same thing in both places. */
export function resolveTemplatePermissions(
  permissionKeys: (typeof ROLE_TEMPLATES)[number]['permissionKeys'],
  allPermissions: Permission[],
  viewOnlyPermissions: Permission[],
): Permission[] {
  if (permissionKeys === 'ALL') return allPermissions;
  if (permissionKeys === 'VIEW_ONLY') return viewOnlyPermissions;
  const keys = new Set<string>(permissionKeys);
  return allPermissions.filter((p) => keys.has(p.key));
}

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
   * Force the first admin to change their password at next login (before the
   * account is usable). Set by the FleetHQ admin "issue a customer login" flow,
   * which creates the account with a temporary password it shows once and never
   * stores. Defaults to false for self-serve signup / seed, where the admin
   * chose their own password.
   */
  adminMustChangePassword?: boolean;
  /**
   * Length of the native free trial to grant (days). Self-serve signup passes
   * this so a new company starts on the Trial tier; the seed/dev bootstrap
   * omits it (no trial — dev runs unlimited via BILLING_ENFORCED=false anyway).
   */
  trialDays?: number;
  /** Auth/Billing Platform Phase 4 (registration depth) — org intake fields, all optional. */
  abn?: string;
  industry?: string;
  phone?: string;
  fleetSizeEstimate?: number;
  /**
   * When the admin accepted the Terms of Service/Privacy Policy — set by
   * `CompaniesService.signup()` from `SignupCompanyDto.acceptedTerms`
   * (mandatory there). Internal dev/seed callers omit it; the column is
   * nullable for exactly that reason.
   */
  termsAcceptedAt?: Date;
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
      abn: input.abn,
      industry: input.industry,
      phone: input.phone,
      fleetSizeEstimate: input.fleetSizeEstimate,
      termsAcceptedAt: input.termsAcceptedAt,
    },
  });

  const allPermissions = await tx.permission.findMany();
  const viewOnlyPermissions = allPermissions.filter((p) => p.key.endsWith(':view'));

  // Every named system-template Role a new company starts with
  // (14-Security/Permissions_Model.md: companies can edit or clone any of
  // them) — Auth/Billing Platform Phase 4's "named role templates": beyond
  // Administrator/Read Only, a purpose-built bundle per common job function
  // (Driver, Dispatcher, Fleet/Workshop Manager, Compliance Officer,
  // Accounts), so a brand-new company isn't stuck hand-building or
  // cloning-and-pruning a role for its first hire in one of those roles.
  const roleIdsByName = new Map<string, string>();
  for (const template of ROLE_TEMPLATES) {
    const permissions = resolveTemplatePermissions(template.permissionKeys, allPermissions, viewOnlyPermissions);
    const role = await tx.role.create({
      data: {
        companyId,
        name: template.name,
        description: template.description,
        isSystemTemplate: true,
        permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
      },
    });
    roleIdsByName.set(template.name, role.id);
  }
  const administratorRoleId = roleIdsByName.get('Administrator')!;
  const readOnlyRoleId = roleIdsByName.get('Read Only')!;

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
        passwordHash: await bcrypt.hash(input.adminPassword, resolveBcryptCost()),
        fullName: input.adminFullName,
        email: input.adminEmail ?? null,
        mustChangePassword: input.adminMustChangePassword ?? false,
      },
    ],
  });

  const adminMembership = await tx.companyMembership.create({
    data: { userId: adminUserId, companyId, roleId: administratorRoleId },
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
    administratorRoleId,
    readOnlyRoleId,
    adminUserId,
    adminUsername: input.adminUsername,
    adminMembershipId: adminMembership.id,
  };
}
