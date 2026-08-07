/**
 * Create a customer **Company** and its first **Administrator** login — the
 * account a fleet operator uses to sign in to FleetHQ (fleethq.online).
 *
 * This is NOT the FleetHQ-staff superadmin bootstrap (`bootstrap-admin.ts`,
 * `npm run admin:bootstrap`). This creates a tenant org + an org admin User
 * with the full "Administrator" role, using the exact same `provisionCompany`
 * path as self-serve signup and the seed scripts — so the account is
 * indistinguishable from one created any other way.
 *
 * Credentials come from the environment, never from source, so nothing
 * sensitive is committed. Run it against whichever database you point
 * DATABASE_URL at (locally, or e.g. `railway run` against the deployed DB):
 *
 *   ADMIN_COMPANY_NAME="Acme Freight" \
 *   ADMIN_USERNAME="you@example.com" \
 *   ADMIN_PASSWORD="<your password>" \
 *   ADMIN_FULL_NAME="Your Name" \
 *   ADMIN_EMAIL="you@example.com" \
 *   npm run admin:create-company
 *
 * Notes:
 * - The login username is ADMIN_USERNAME (email is fine as the username).
 * - Requires the permission catalog to be seeded first (migrations +
 *   `npm run permissions:sync`, which the normal deploy already runs).
 * - Idempotency: it refuses to run if the username already exists, rather than
 *   creating a duplicate. Re-running with a new username/company is safe.
 * - Uses the same DATABASE_URL the app/migrations use. That role must be able
 *   to insert the new Company + User rows (the migration/owner connection used
 *   for `prisma migrate deploy` and the other seed scripts is the intended
 *   one). If a restricted, RLS-enforcing role is used instead, set
 *   ADMIN_DB_BYPASSES_RLS=false and this script will set the tenant GUC for
 *   the Company insert.
 */
import './load-env';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { provisionCompany } from '../src/companies/provision-company';
import { isStrongPassword } from '../src/common/validators/is-strong-password.validator';

const prisma = new PrismaClient();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`\n✗ Missing required environment variable: ${name}\n`);
    process.exit(1);
  }
  return value;
}

/** Show which database host we're about to write to, so nobody targets the wrong one by accident. */
function describeTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(DATABASE_URL not parseable)';
  }
}

async function main() {
  const companyName = required('ADMIN_COMPANY_NAME');
  const username = required('ADMIN_USERNAME');
  const password = required('ADMIN_PASSWORD');
  const fullName = process.env.ADMIN_FULL_NAME?.trim() || username;
  const email = process.env.ADMIN_EMAIL?.trim() || undefined;
  // Default true: the seed/migration connection (like the other seed scripts) is
  // the schema owner and bypasses RLS, so no tenant GUC is needed on insert.
  const dbBypassesRls = (process.env.ADMIN_DB_BYPASSES_RLS ?? 'true').toLowerCase() !== 'false';

  if (!isStrongPassword(password)) {
    console.error(
      '\n✗ ADMIN_PASSWORD is too weak. Use at least 8 characters combining at least two of: ' +
        'lowercase, uppercase, numbers, symbols.\n',
    );
    process.exit(1);
  }

  console.log(`\n→ Target database: ${describeTarget()}`);
  console.log(`→ Creating company "${companyName}" with admin login "${username}"…\n`);

  // Fail early on a friendly message instead of a raw unique-constraint error.
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.error(
      `✗ A user with username "${username}" already exists. Pick a different ADMIN_USERNAME, ` +
        `or reset that account's password instead of creating a new one.\n`,
    );
    process.exit(1);
  }

  const permissionCount = await prisma.permission.count();
  if (permissionCount === 0) {
    console.error(
      '✗ No permissions found in the database. Run migrations and seed the permission catalog first ' +
        '(`npm run prisma:migrate:deploy` then `npm run permissions:sync`), then re-run this script.\n',
    );
    process.exit(1);
  }

  // Pre-generate the company id so we can set the RLS tenant GUC before the
  // INSERT when running as a restricted role (the companies RLS policy checks
  // `id = current_setting(...)` even on INSERT).
  const companyId = randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    if (!dbBypassesRls) {
      // Parameterized (set_config, not string-interpolated SET LOCAL) to match
      // PrismaService.withTenant — hygiene, even though companyId is a
      // server-generated UUID here.
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
    }
    return provisionCompany(tx, {
      companyId,
      companyName,
      adminUsername: username,
      adminPassword: password,
      adminFullName: fullName,
      adminEmail: email,
    });
  });

  console.log('✓ Done.\n');
  console.log('  Company:   ', result.companyName, `(${result.companyId})`);
  console.log('  Sign in with');
  console.log('    Username: ', result.adminUsername);
  console.log('    Password:  (the ADMIN_PASSWORD you supplied)');
  console.log('  Role:       Administrator (full access)\n');
}

main()
  .catch((err) => {
    console.error('\n✗ Failed to create company admin:', err instanceof Error ? err.message : err, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
