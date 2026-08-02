/**
 * Production boot-time bootstrap. Unlike `prisma/seed.ts` and everything under
 * `scripts/` (all `ts-node`, and deliberately excluded from the runtime image),
 * this lives under `src/` so `nest build` compiles it into `dist/` — which means
 * it can actually run inside the deployed container, invoked from
 * `docker-entrypoint.sh` right after `prisma migrate deploy`.
 *
 * It does these things:
 *
 *  1. **Reference data** (customer permission catalog + built-in asset classes,
 *     plus the admin-platform permission catalog and its Super Admin / Support
 *     system roles) — run on every boot, fully idempotent (upserts). This closes
 *     a real production gap: nothing seeded the `permission`/`admin_permissions`
 *     tables in prod (the only seeders were ts-node), so a freshly-migrated
 *     database had zero permissions — every company got an *empty* Administrator
 *     role, and there was no Super Admin role for a staff account to hold.
 *
 *  2. **First company + admin login** (customer app) — only when
 *     `BOOTSTRAP_COMPANY_ADMIN=true` and the username doesn't already exist.
 *     Credentials come from env, never source. Idempotent: an existing username
 *     is left untouched.
 *
 *  3. **First FleetHQ staff admin** (the `/admin` console) — only when
 *     `BOOTSTRAP_STAFF_ADMIN=true` and the username doesn't already exist. This
 *     is the production-safe equivalent of `scripts/bootstrap-admin.ts`, which
 *     is `ts-node` and therefore excluded from the runtime image and can't run
 *     in the container. The staff console is a separate auth realm from the
 *     customer app (a different table), so the same person needs an AdminUser to
 *     reach it — you can point this at the same email/password you use for the
 *     customer app if you want one set of credentials for both. Created with the
 *     Super Admin role. Credentials come from env, never source; idempotent.
 *
 * Never throws: any failure is logged and swallowed, so a bootstrap problem can
 * never stop the API from starting (the entrypoint also guards the call). Uses
 * `DATABASE_URL` — the schema-owner connection that runs migrations — which can
 * insert Company/Role/User rows; on Railway's managed Postgres that role is a
 * superuser and bypasses RLS. If yours is a restricted, RLS-enforcing role, set
 * `BOOTSTRAP_ADMIN_DB_BYPASSES_RLS=false` and the company GUC is set before the
 * insert (mirrors scripts/create-company-admin.ts).
 */
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { PERMISSION_CATALOG } from '../common/permissions/permission-catalog';
import { provisionCompany } from '../companies/provision-company';
import { isStrongPassword } from '../common/validators/is-strong-password.validator';
import { reconcileAdminPermissions, SUPER_ADMIN_ROLE_NAME } from './admin-permissions-reconcile';

const BUILT_IN_ASSET_CLASSES = [
  { key: 'LAND', name: 'Land' },
  { key: 'AIR', name: 'Air' },
  { key: 'SEA', name: 'Sea' },
];

async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const entry of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: entry.key },
      update: { category: entry.category, description: entry.description },
      create: entry,
    });
  }
  for (const c of BUILT_IN_ASSET_CLASSES) {
    const existing = await prisma.assetClass.findFirst({ where: { companyId: null, key: c.key } });
    if (existing) {
      await prisma.assetClass.update({ where: { id: existing.id }, data: { name: c.name, isImplemented: true } });
    } else {
      await prisma.assetClass.create({ data: { companyId: null, key: c.key, name: c.name, isImplemented: true } });
    }
  }
  console.log(
    `[bootstrap] reference data seeded (${PERMISSION_CATALOG.length} permissions, ${BUILT_IN_ASSET_CLASSES.length} asset classes) — idempotent.`,
  );
}

interface BootstrapAdminInput {
  companyName: string;
  username: string;
  password: string;
  fullName: string;
  email: string | undefined;
}

/** Read + validate the company-admin inputs from env, or null (with a reason logged) when it shouldn't run. */
function readBootstrapAdminInput(): BootstrapAdminInput | null {
  if ((process.env.BOOTSTRAP_COMPANY_ADMIN ?? '').toLowerCase() !== 'true') return null;

  const companyName = process.env.BOOTSTRAP_COMPANY_NAME?.trim();
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!companyName || !username || !password) {
    console.warn(
      '[bootstrap] BOOTSTRAP_COMPANY_ADMIN=true but one of BOOTSTRAP_COMPANY_NAME / BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD is missing — skipping company-admin creation.',
    );
    return null;
  }
  if (!isStrongPassword(password)) {
    console.warn(
      '[bootstrap] BOOTSTRAP_ADMIN_PASSWORD is too weak (need ≥8 chars mixing at least two of lowercase/uppercase/number/symbol) — skipping company-admin creation.',
    );
    return null;
  }
  return {
    companyName,
    username,
    password,
    fullName: process.env.BOOTSTRAP_ADMIN_FULL_NAME?.trim() || username,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || undefined,
  };
}

async function maybeCreateCompanyAdmin(prisma: PrismaClient): Promise<void> {
  const input = readBootstrapAdminInput();
  if (!input) return;
  const { companyName, username, password, fullName, email } = input;

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`[bootstrap] company-admin login "${username}" already exists — nothing to do.`);
    return;
  }

  const bypassesRls = (process.env.BOOTSTRAP_ADMIN_DB_BYPASSES_RLS ?? 'true').toLowerCase() !== 'false';
  const companyId = randomUUID();

  await prisma.$transaction(async (tx) => {
    if (!bypassesRls) {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_company_id = '${companyId}'`);
    }
    return provisionCompany(tx, {
      companyId,
      companyName,
      adminUsername: username,
      adminPassword: password,
      adminFullName: fullName ?? username,
      adminEmail: email,
    });
  });
  console.log(`[bootstrap] created company "${companyName}" with admin login "${username}".`);
}

interface BootstrapStaffAdminInput {
  username: string;
  password: string;
  fullName: string;
  email: string;
}

/**
 * Read + validate the staff-admin inputs from env, or null (with a reason
 * logged) when it shouldn't run. Each field falls back to the customer
 * `BOOTSTRAP_ADMIN_*` value so a solo operator can set one set of credentials
 * and get a login that works in both the customer app and the /admin console.
 */
function readBootstrapStaffAdminInput(): BootstrapStaffAdminInput | null {
  if ((process.env.BOOTSTRAP_STAFF_ADMIN ?? '').toLowerCase() !== 'true') return null;

  const username = (process.env.BOOTSTRAP_STAFF_ADMIN_USERNAME ?? process.env.BOOTSTRAP_ADMIN_USERNAME)?.trim();
  const password = process.env.BOOTSTRAP_STAFF_ADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    console.warn(
      '[bootstrap] BOOTSTRAP_STAFF_ADMIN=true but no username/password available ' +
        '(set BOOTSTRAP_STAFF_ADMIN_USERNAME/PASSWORD, or reuse BOOTSTRAP_ADMIN_USERNAME/PASSWORD) — skipping staff-admin creation.',
    );
    return null;
  }
  if (!isStrongPassword(password)) {
    console.warn(
      '[bootstrap] staff-admin password is too weak (need ≥8 chars mixing at least two of lowercase/uppercase/number/symbol) — skipping staff-admin creation.',
    );
    return null;
  }
  const email = (process.env.BOOTSTRAP_STAFF_ADMIN_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL)?.trim() || username;
  const fullName = (process.env.BOOTSTRAP_STAFF_ADMIN_FULL_NAME ?? process.env.BOOTSTRAP_ADMIN_FULL_NAME)?.trim() || username;
  return { username, password, fullName, email };
}

async function maybeCreateStaffAdmin(prisma: PrismaClient): Promise<void> {
  const input = readBootstrapStaffAdminInput();
  if (!input) return;
  const { username, password, fullName, email } = input;

  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    console.log(`[bootstrap] staff-admin login "${username}" already exists — nothing to do.`);
    return;
  }

  // reconcileAdminPermissions (called just before this in main) guarantees the
  // Super Admin role exists on a freshly-migrated database.
  const superAdminRole = await prisma.adminRole.findUnique({ where: { name: SUPER_ADMIN_ROLE_NAME } });
  if (!superAdminRole) {
    console.warn(`[bootstrap] "${SUPER_ADMIN_ROLE_NAME}" role not found — skipping staff-admin creation.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.adminUser.create({ data: { username, email, fullName, passwordHash, roleId: superAdminRole.id } });
  console.log(
    `[bootstrap] created FleetHQ staff admin "${username}" (${SUPER_ADMIN_ROLE_NAME}) — sign in at /admin. ` +
      'Strongly recommend enabling MFA on first login.',
  );
}

async function main(): Promise<void> {
  if ((process.env.BOOTSTRAP_ON_BOOT ?? 'true').toLowerCase() === 'false') {
    console.log('[bootstrap] BOOTSTRAP_ON_BOOT=false — skipping bootstrap.');
    return;
  }
  const prisma = new PrismaClient();
  try {
    await seedReferenceData(prisma);
    // Admin-platform permission catalog + Super Admin / Support system roles —
    // idempotent, and a prerequisite for maybeCreateStaffAdmin below.
    const adminReconcile = await reconcileAdminPermissions(prisma);
    console.log(
      `[bootstrap] admin permissions reconciled (${adminReconcile.permissionsUpserted} permission(s); ` +
        `Super Admin role ${adminReconcile.superAdminRoleCreated ? 'created' : 'present'}).`,
    );
    await maybeCreateCompanyAdmin(prisma);
    await maybeCreateStaffAdmin(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // Non-fatal by design: log and let the app boot anyway.
  console.error('[bootstrap] non-fatal error (the API will still start):', err);
});
