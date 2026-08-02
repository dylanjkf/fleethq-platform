/**
 * Production boot-time bootstrap. Unlike `prisma/seed.ts` and everything under
 * `scripts/` (all `ts-node`, and deliberately excluded from the runtime image),
 * this lives under `src/` so `nest build` compiles it into `dist/` — which means
 * it can actually run inside the deployed container, invoked from
 * `docker-entrypoint.sh` right after `prisma migrate deploy`.
 *
 * It does two things:
 *
 *  1. **Reference data** (permission catalog + built-in asset classes) — run on
 *     every boot, fully idempotent (upserts). This closes a real production gap:
 *     nothing seeded the `permission` table in prod (the only seeders were
 *     ts-node), so a freshly-migrated database had zero permissions, and every
 *     company provisioned against it got an *empty* Administrator role.
 *
 *  2. **First company + admin login** — only when `BOOTSTRAP_COMPANY_ADMIN=true`
 *     and the username doesn't already exist. Credentials come from env, never
 *     source. Idempotent: an existing username is left untouched.
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
import { PrismaClient } from '@prisma/client';
import { PERMISSION_CATALOG } from '../common/permissions/permission-catalog';
import { provisionCompany } from '../companies/provision-company';
import { isStrongPassword } from '../common/validators/is-strong-password.validator';

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

async function main(): Promise<void> {
  if ((process.env.BOOTSTRAP_ON_BOOT ?? 'true').toLowerCase() === 'false') {
    console.log('[bootstrap] BOOTSTRAP_ON_BOOT=false — skipping bootstrap.');
    return;
  }
  const prisma = new PrismaClient();
  try {
    await seedReferenceData(prisma);
    await maybeCreateCompanyAdmin(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // Non-fatal by design: log and let the app boot anyway.
  console.error('[bootstrap] non-fatal error (the API will still start):', err);
});
