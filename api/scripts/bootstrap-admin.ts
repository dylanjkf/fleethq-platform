/**
 * One-time creation of the FIRST FleetHQ staff account (Super Admin role).
 * This is the only way an AdminUser is ever created without an existing
 * admin doing it — there is no public admin-signup endpoint anywhere on
 * purpose (21-Admin-Platform/Overview.md), and Phase 2's admin-user-management
 * endpoints (creating additional staff accounts) require an already-logged-in
 * Super Admin, which doesn't exist yet on a fresh environment.
 *
 * Refuses to run if ANY AdminUser already exists — this script is the
 * bootstrap, not a general "create an admin" tool. Once the first account
 * exists, create every subsequent one through the authenticated admin API
 * (Phase 2) so it's covered by audit logging.
 *
 * In production, every field must come from real env vars and the password
 * must pass the same strength policy as every other password in this
 * codebase (isStrongPassword) — refuses to run with a missing/weak value
 * rather than silently creating a default-credential account (the same
 * "no default account in production" discipline as prisma/seed.ts's demo
 * companies). Outside production, omitted fields fall back to documented
 * dev-only defaults for convenience.
 *
 * Run via `npm run admin:bootstrap`. Strongly recommend enabling MFA
 * (`POST /v1/admin/auth/mfa/setup` + `/mfa/enable`) immediately after first
 * login — this script does not enrol MFA itself, since it can't display a QR
 * code from a one-shot CLI run.
 */
import './load-env';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { isStrongPassword } from '../src/common/validators/is-strong-password.validator';
import { reconcileAdminPermissions, SUPER_ADMIN_ROLE_NAME } from '../prisma/reconcile-admin-permissions';

const DEV_USERNAME = 'admin@fleethq.internal';
const DEV_PASSWORD = 'FleetHQ-dev-bootstrap-1!';

const prisma = new PrismaClient();

async function main() {
  const isProduction = process.env.NODE_ENV === 'production';

  const existing = await prisma.adminUser.count();
  if (existing > 0) {
    console.log(`Refusing to bootstrap: ${existing} admin user(s) already exist. Use the admin API to create more.`);
    process.exitCode = 1;
    return;
  }

  const username = process.env.ADMIN_BOOTSTRAP_USERNAME ?? (isProduction ? undefined : DEV_USERNAME);
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL ?? (isProduction ? undefined : DEV_USERNAME);
  const fullName = process.env.ADMIN_BOOTSTRAP_FULL_NAME ?? (isProduction ? undefined : 'FleetHQ Super Admin');
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? (isProduction ? undefined : DEV_PASSWORD);

  if (!username || !email || !fullName || !password) {
    throw new Error(
      'ADMIN_BOOTSTRAP_USERNAME, ADMIN_BOOTSTRAP_EMAIL, ADMIN_BOOTSTRAP_FULL_NAME, and ADMIN_BOOTSTRAP_PASSWORD ' +
        'are all required in production — refusing to fall back to a default credential on a real environment.',
    );
  }
  if (!isStrongPassword(password)) {
    throw new Error(
      'ADMIN_BOOTSTRAP_PASSWORD does not meet the password policy (at least 8 characters, combining at least ' +
        'two of: lowercase, uppercase, numbers, symbols, and not a well-known common password).',
    );
  }
  if (isProduction && password === DEV_PASSWORD) {
    throw new Error('Refusing to use the dev-only default password in production.');
  }

  // Ensures ADMIN_PERMISSIONS/system-template roles exist even on a
  // completely fresh database — safe and idempotent (see its own docstring).
  await reconcileAdminPermissions(prisma);

  const superAdminRole = await prisma.adminRole.findUniqueOrThrow({ where: { name: SUPER_ADMIN_ROLE_NAME } });
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.adminUser.create({
    data: { username, email, fullName, passwordHash, roleId: superAdminRole.id },
  });

  console.log(`Created the first FleetHQ admin account: "${admin.username}" (${SUPER_ADMIN_ROLE_NAME}).`);
  if (!isProduction) {
    console.log(`  Dev-only credentials — username="${username}" password="${password}"`);
  }
  console.log('  Enable MFA immediately: POST /v1/admin/auth/mfa/setup then /v1/admin/auth/mfa/enable.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
