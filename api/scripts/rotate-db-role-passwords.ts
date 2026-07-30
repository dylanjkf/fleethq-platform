/**
 * SECURITY-CRITICAL — read this before touching it.
 *
 * apps/api/prisma/migrations/20260713063137_row_level_security,
 * .../20260713080000_admin_entities_and_users_rls, and
 * .../20260730092032_admin_platform_foundation CREATE the `fleetos_app`,
 * `fleetos_auth`, and `fleetos_admin` Postgres roles with hardcoded passwords
 * (`fleetos_app_dev_only`, `fleetos_auth_dev_only`, `fleetos_admin_dev_only`).
 * That's unavoidable — a migration file is version-controlled and can never
 * contain a real per-environment secret — but it means every real deploy MUST
 * immediately rotate all three roles to real, per-environment, random
 * passwords, or the "row-level security only holds if the app can't bypass
 * it" guarantee (11-Database/Data_Model.md) — and, for `fleetos_admin`, the
 * entire admin-platform isolation model (21-Admin-Platform/Overview.md) — is
 * sitting behind a password anyone who has ever read this repository's git
 * history already knows.
 *
 * Run this ONCE per environment, immediately after `prisma migrate deploy`
 * creates the roles for the first time, connected as the schema-owning role
 * (which has ALTER ROLE privilege on all three). It is idempotent — re-running
 * it with the same passwords is a safe no-op, so it's also safe to run again
 * any time you want to force-rotate all three passwords (e.g. after a
 * suspected leak).
 *
 * The new passwords come from environment variables that the deploy
 * pipeline populates from the environment's Secrets Manager secret (see
 * infra/terraform/modules/secrets and .github/workflows/deploy-api.yml) —
 * never hardcoded here, never passed on a command line where they'd land in
 * shell history.
 */
import './load-env';
import { PrismaClient } from '@prisma/client';

const ROLES = [
  { name: 'fleetos_app', envVar: 'NEW_APP_ROLE_PASSWORD' },
  { name: 'fleetos_auth', envVar: 'NEW_AUTH_ROLE_PASSWORD' },
  { name: 'fleetos_admin', envVar: 'NEW_ADMIN_ROLE_PASSWORD' },
] as const;

async function main() {
  const prisma = new PrismaClient(); // connects via DATABASE_URL — the schema-owning role, the only one with ALTER ROLE privilege on these two roles

  try {
    for (const role of ROLES) {
      const password = process.env[role.envVar];
      if (!password) {
        throw new Error(
          `${role.envVar} is not set. Refusing to proceed — this would either leave the role on its hardcoded ` +
            `dev-only password (a real security gap) or fail loudly, and failing loudly is correct here.`,
        );
      }
      if (password.includes('dev_only')) {
        throw new Error(
          `${role.envVar} looks like the migration's own hardcoded dev-only placeholder, not a real generated ` +
            `secret. Refusing to "rotate" a role onto the same value it's already vulnerable with.`,
        );
      }

      // Prisma's query engine explicitly refuses parameter binding on ALTER
      // statements (https://pris.ly/d/execute-raw) — there is no
      // $executeRawUnsafe(sql, [password]) form for DDL like there is for
      // DML. The password is therefore interpolated directly, which is only
      // safe because it's constrained to a fixed alphanumeric charset below
      // (the same charset infra/terraform/modules/secrets' random_password
      // resources generate — special = false) — this is NOT safe practice
      // for a password coming from anything a user could influence.
      if (!/^[A-Za-z0-9]{16,}$/.test(password)) {
        throw new Error(
          `${role.envVar} must be a plain alphanumeric string of at least 16 characters (matching how ` +
            `Terraform's random_password generates it). Refusing to interpolate an unvalidated value into SQL.`,
        );
      }

      await prisma.$executeRawUnsafe(`ALTER ROLE ${role.name} WITH PASSWORD '${password}'`);
      console.log(`Rotated password for role "${role.name}".`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to rotate DB role passwords:', err);
  process.exit(1);
});
