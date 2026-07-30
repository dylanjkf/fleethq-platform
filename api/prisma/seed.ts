/**
 * Local dev bootstrap. Runs as the schema-owning DB role (DATABASE_URL), not
 * the RLS-constrained runtime role — seeding is a system/operator action, not
 * a tenant request, so there's no company context to scope it to yet. This is
 * the one legitimate place in the codebase that talks to Postgres outside the
 * `fleetos_app` role.
 *
 * Company/Role/User provisioning itself now goes through the same
 * provisionCompany() function POST /v1/companies uses, so this script and the
 * self-service signup endpoint can't quietly drift apart — this file only
 * adds the idempotency check (skip if a company with this name already
 * exists) and the platform-wide reference data (Asset Classes, Permissions)
 * that provisionCompany() assumes are already seeded.
 */
import '../scripts/load-env';
import { PrismaClient } from '@prisma/client';
import { PERMISSION_CATALOG } from '../src/common/permissions/permission-catalog';
import { provisionCompany } from '../src/companies/provision-company';
import { reconcileSystemRolePermissions } from './reconcile-permissions';

const prisma = new PrismaClient();

const DEV_PASSWORD = 'fleetos-dev-password';

/** The shared, company-agnostic built-in categories (company_id = null). */
async function seedAssetClasses() {
  for (const c of [
    { key: 'LAND', name: 'Land' },
    { key: 'AIR', name: 'Air' },
    { key: 'SEA', name: 'Sea' },
  ]) {
    const existing = await prisma.assetClass.findFirst({ where: { companyId: null, key: c.key } });
    if (existing) {
      await prisma.assetClass.update({ where: { id: existing.id }, data: { name: c.name, isImplemented: true } });
    } else {
      await prisma.assetClass.create({ data: { companyId: null, key: c.key, name: c.name, isImplemented: true } });
    }
  }
}

async function seedPermissions() {
  for (const entry of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: entry.key },
      update: { category: entry.category, description: entry.description },
      create: entry,
    });
  }
}

async function seedCompany(companyName: string, adminUsername: string) {
  const existing = await prisma.company.findFirst({ where: { name: companyName } });
  if (existing) {
    const membership = await prisma.companyMembership.findFirst({
      where: { companyId: existing.id },
      include: { user: true },
    });
    return {
      companyId: existing.id,
      companyName: existing.name,
      adminUsername: membership?.user.username ?? adminUsername,
      wasCreated: false,
    };
  }

  const result = await provisionCompany(prisma, {
    companyName,
    adminUsername,
    adminPassword: DEV_PASSWORD,
    adminFullName: `${companyName} Administrator`,
  });
  return {
    companyId: result.companyId,
    companyName: result.companyName,
    adminUsername: result.adminUsername,
    wasCreated: true,
  };
}

/** A minimal, self-contained Dispatch demo so a fresh company isn't an empty screen. */
async function seedDispatchDemo(companyId: string, companyName: string) {
  const attachedUnit = await prisma.attachedUnit.create({
    data: { companyId, name: 'Trailer 1' },
  });

  await prisma.job.create({
    data: { companyId, title: `Sample delivery run for ${companyName}` },
  });

  console.log(`  Seeded demo attached unit "${attachedUnit.name}" and one unassigned job.`);
}

/**
 * A minimal Compliance demo: one Asset with three documents spanning all
 * three expiry-status buckets (valid / expiring soon / expired), so the
 * Compliance page has something real to show rather than an empty state.
 */
async function seedComplianceDemo(companyId: string) {
  const landClass = await prisma.assetClass.findFirstOrThrow({ where: { companyId: null, key: 'LAND' } });
  const asset = await prisma.asset.create({
    data: { companyId, assetClassId: landClass.id, name: 'Compliance Demo Truck' },
  });

  const dayMs = 24 * 60 * 60 * 1000;
  await prisma.complianceDocument.createMany({
    data: [
      {
        companyId,
        assetId: asset.id,
        documentType: 'REGISTRATION',
        documentNumber: 'REGO-0001',
        expiresAt: new Date(Date.now() + 180 * dayMs),
      },
      {
        companyId,
        assetId: asset.id,
        documentType: 'INSURANCE',
        documentNumber: 'POL-0002',
        expiresAt: new Date(Date.now() + 14 * dayMs),
      },
      {
        companyId,
        assetId: asset.id,
        documentType: 'ROADWORTHY',
        documentNumber: 'RWC-0003',
        expiresAt: new Date(Date.now() - 3 * dayMs),
      },
    ],
  });

  console.log(`  Seeded demo asset "${asset.name}" with 3 compliance documents (valid/expiring soon/expired).`);
}

/**
 * The always-safe, idempotent half: platform reference data (Asset Classes,
 * Permissions) plus reconciling every existing company's system-template roles
 * to the current permission catalog. This is *all* a production deploy runs —
 * deploy-api.yml calls this script exactly for this, never for the demo tenants.
 */
async function seedReferenceData() {
  await seedAssetClasses();
  await seedPermissions();

  // Closes the seed-script permission drift gap: every existing company's
  // Administrator/Read Only system-template role gets any permission added
  // to the catalog since it was created — not just brand-new companies.
  const reconciled = await reconcileSystemRolePermissions(prisma);
  console.log(
    `  Reconciled ${reconciled.administratorRolesChecked} Administrator role(s) and ${reconciled.readOnlyRolesChecked} Read Only role(s); granted ${reconciled.permissionsGranted} missing permission(s).`,
  );
}

async function main() {
  await seedReferenceData();

  // The demo companies below carry a well-known default password (DEV_PASSWORD)
  // and are real, loginable tenant accounts. Creating them in production would
  // be a default-account / default-password vulnerability — a core Cyber
  // Essentials secure-configuration and access-control failure — so this whole
  // block is dev/test only. In production `npm run seed` is the reference-data
  // + system-role bootstrap and nothing more (see deploy-api.yml, which also
  // sets NODE_ENV=production for exactly this gate).
  if (process.env.NODE_ENV === 'production') {
    console.log('Seed complete (production: reference data + system roles only — no demo companies).');
    return;
  }

  // Two companies so tenant isolation is manually verifiable: log in as each
  // and confirm neither can see the other's Assets/Operators.
  const acme = await seedCompany('Acme Couriers', 'admin@acme');
  const southernStar = await seedCompany('Southern Star Logistics', 'admin@southernstar');

  if (acme.wasCreated) {
    await seedDispatchDemo(acme.companyId, acme.companyName);
    await seedComplianceDemo(acme.companyId);
  }
  if (southernStar.wasCreated) {
    await seedDispatchDemo(southernStar.companyId, southernStar.companyName);
    await seedComplianceDemo(southernStar.companyId);
  }

  console.log('Seed complete.');
  console.log(`  ${acme.companyName}: username="${acme.adminUsername}" password="${DEV_PASSWORD}"`);
  console.log(
    `  ${southernStar.companyName}: username="${southernStar.adminUsername}" password="${DEV_PASSWORD}"`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
