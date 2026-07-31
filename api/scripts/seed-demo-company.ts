/**
 * Seeds a realistic demo company — one that looks like it's been running for
 * ~6 months: 10 assets (with specs), a handful of operators, customers and
 * depots, 100+ jobs spread across ~180 days as genuine multi-drop delivery
 * runs (each with stops, outcomes, and proof), plus some maintenance and
 * compliance history. Meant for a hands-on demo / your own test drive, not
 * load testing.
 *
 * Idempotent: safe to re-run — it tops up toward the target counts and skips
 * whatever already exists. Run with:  npm run seed:demo   (from apps/api)
 *
 * Login afterwards: username "admin@rapid"  password "fleetos-dev-password"
 *
 * Deliberately omits maintenance `severity` (it defaults) so this script keeps
 * working regardless of that field's presence.
 */
import './load-env';
import { PrismaClient, JobStatus, StopOutcome, StopFailureReason, ComplianceDocumentType, MaintenanceJobStatus } from '@prisma/client';
import { provisionCompany } from '../src/companies/provision-company';
import { assertSafeToSeed } from './seed-guard';

assertSafeToSeed('seed-demo-company');

const prisma = new PrismaClient();

const COMPANY_NAME = 'Rapid Dispatch Couriers';
const ADMIN_USERNAME = 'admin@rapid';
const DEV_PASSWORD = 'fleetos-dev-password';

const HISTORY_DAYS = 180;
const JOB_COUNT = 120;

const DAY = 86_400_000;
const now = Date.now();
const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];
const daysAgo = (d: number) => new Date(now - d * DAY);

const ASSET_SPECS = [
  { name: 'Truck 01 — XZ12AB', make: 'Isuzu', model: 'NPR 45-150', year: 2021, registration: 'XZ12AB', odometer: 84_500 },
  { name: 'Truck 02 — XZ34CD', make: 'Isuzu', model: 'NLR 45-150', year: 2022, registration: 'XZ34CD', odometer: 61_200 },
  { name: 'Van 03 — XZ56EF', make: 'Ford', model: 'Transit 350L', year: 2020, registration: 'XZ56EF', odometer: 132_800 },
  { name: 'Van 04 — XZ78GH', make: 'Ford', model: 'Transit Custom', year: 2023, registration: 'XZ78GH', odometer: 28_400 },
  { name: 'Van 05 — XZ90IJ', make: 'Mercedes-Benz', model: 'Sprinter 314', year: 2021, registration: 'XZ90IJ', odometer: 97_100 },
  { name: 'Van 06 — YA12KL', make: 'Mercedes-Benz', model: 'Sprinter 316', year: 2022, registration: 'YA12KL', odometer: 54_300 },
  { name: 'Truck 07 — YA34MN', make: 'Hino', model: '300 Series', year: 2019, registration: 'YA34MN', odometer: 168_900 },
  { name: 'Truck 08 — YA56OP', make: 'Hino', model: '500 Series', year: 2020, registration: 'YA56OP', odometer: 121_450 },
  { name: 'Van 09 — YA78QR', make: 'Renault', model: 'Master', year: 2021, registration: 'YA78QR', odometer: 76_600 },
  { name: 'Ute 10 — YA90ST', make: 'Toyota', model: 'HiLux SR5', year: 2023, registration: 'YA90ST', odometer: 33_900 },
];

const OPERATOR_NAMES = ['Jamie Nguyen', 'Alex Morgan', 'Sam Patel', 'Riley Chen', 'Casey O’Brien', 'Jordan Silva'];

const CUSTOMERS = [
  { name: 'Northside Grocers', address: '12 Market St, Preston VIC 3072', contactName: 'Dana', phone: '03 9000 1001' },
  { name: 'Bayside Pharmacy', address: '88 Beach Rd, Brighton VIC 3186', contactName: 'Wei', phone: '03 9000 1002' },
  { name: 'Central Hardware', address: '5 Depot Rd, Coburg VIC 3058', contactName: 'Priya', phone: '03 9000 1003' },
  { name: 'Riverside Cafe', address: '210 River St, Richmond VIC 3121', contactName: 'Tom', phone: '03 9000 1004' },
  { name: 'Eastwood Electrical', address: '47 Trade Way, Box Hill VIC 3128', contactName: 'Mei', phone: '03 9000 1005' },
  { name: 'Harbour Freight Co', address: '3 Dock St, Port Melbourne VIC 3207', contactName: 'Luca', phone: '03 9000 1006' },
  { name: 'Summit Office Supplies', address: '19 Hill Rd, Kew VIC 3101', contactName: 'Nadia', phone: '03 9000 1007' },
  { name: 'Greenline Nursery', address: '90 Garden Ave, Bulleen VIC 3105', contactName: 'Owen', phone: '03 9000 1008' },
  { name: 'Metro Auto Parts', address: '71 Industrial Dr, Dandenong VIC 3175', contactName: 'Sara', phone: '03 9000 1009' },
  { name: 'Lakeside Bakery', address: '6 Lake Pde, Caroline Springs VIC 3023', contactName: 'Ben', phone: '03 9000 1010' },
];

const DEPOTS = [
  { name: 'Main Depot — Coburg', address: '2 Sydney Rd, Coburg VIC 3058' },
  { name: 'Southern Depot — Dandenong', address: '140 Frankston-Dandenong Rd, Dandenong VIC 3175' },
];

const FAIL_REASONS = [StopFailureReason.NOBODY_HOME, StopFailureReason.BUSINESS_CLOSED, StopFailureReason.ADDRESS_ISSUE, StopFailureReason.ACCESS_DENIED];
const RECIPIENTS = ['J. Smith', 'Reception', 'M. Lee', 'Front desk', 'A. Brown', 'Warehouse'];

async function main() {
  const existing = await prisma.company.findFirst({ where: { name: COMPANY_NAME } });
  let companyId: string;
  if (existing) {
    console.log(`Company "${COMPANY_NAME}" already exists (${existing.id}), reusing it.`);
    companyId = existing.id;
  } else {
    const result = await prisma.$transaction((tx) =>
      provisionCompany(tx, {
        companyName: COMPANY_NAME,
        adminUsername: ADMIN_USERNAME,
        adminPassword: DEV_PASSWORD,
        adminFullName: 'Rapid Dispatch Administrator',
      }),
    );
    companyId = result.companyId;
    console.log(`Provisioned "${COMPANY_NAME}" (${companyId}).`);
  }

  const landClass = await prisma.assetClass.findFirstOrThrow({ where: { companyId: null, key: 'LAND' } });

  // Assets (10, with specs).
  if ((await prisma.asset.count({ where: { companyId } })) < ASSET_SPECS.length) {
    for (const spec of ASSET_SPECS) {
      const already = await prisma.asset.findFirst({ where: { companyId, name: spec.name } });
      if (already) continue;
      await prisma.asset.create({ data: { companyId, assetClassId: landClass.id, odometerUnit: 'km', ...spec } });
    }
    console.log(`Assets ready (${ASSET_SPECS.length}).`);
  }
  const assets = await prisma.asset.findMany({ where: { companyId }, select: { id: true } });

  // Operators.
  if ((await prisma.operator.count({ where: { companyId } })) < OPERATOR_NAMES.length) {
    for (const fullName of OPERATOR_NAMES) {
      const already = await prisma.operator.findFirst({ where: { companyId, fullName } });
      if (!already) await prisma.operator.create({ data: { companyId, fullName } });
    }
    console.log(`Operators ready (${OPERATOR_NAMES.length}).`);
  }
  const operators = await prisma.operator.findMany({ where: { companyId }, select: { id: true } });

  // Customers.
  for (const c of CUSTOMERS) {
    const already = await prisma.customer.findFirst({ where: { companyId, name: c.name } });
    if (!already) await prisma.customer.create({ data: { companyId, ...c } });
  }
  const customers = await prisma.customer.findMany({ where: { companyId }, select: { id: true, name: true, address: true, contactName: true } });

  // Depots.
  for (const d of DEPOTS) {
    const already = await prisma.depot.findFirst({ where: { companyId, name: d.name } });
    if (!already) await prisma.depot.create({ data: { companyId, ...d } });
  }
  const depots = await prisma.depot.findMany({ where: { companyId }, select: { id: true } });

  // Jobs as multi-drop runs across ~180 days.
  const existingJobs = await prisma.job.count({ where: { companyId } });
  if (existingJobs < JOB_COUNT) {
    const toCreate = JOB_COUNT - existingJobs;
    console.log(`Creating ${toCreate} multi-drop runs across ${HISTORY_DAYS} days...`);
    for (let k = 0; k < toCreate; k++) {
      const n = existingJobs + k + 1;
      // Spread across history; the newest few are live (today / upcoming).
      const scheduledDaysAgo = Math.floor((k / toCreate) * HISTORY_DAYS);
      const isHistorical = scheduledDaysAgo > 2;
      const status = isHistorical ? JobStatus.COMPLETED : k % 3 === 0 ? JobStatus.UNASSIGNED : JobStatus.ASSIGNED;
      const scheduledAt = daysAgo(scheduledDaysAgo);
      const job = await prisma.job.create({
        data: {
          companyId,
          title: `${['Morning', 'Midday', 'Afternoon'][n % 3]} run — ${['north', 'south', 'east', 'west', 'CBD'][n % 5]} #${n}`,
          assetId: pick(assets, n).id,
          operatorId: status === JobStatus.UNASSIGNED ? null : pick(operators, n).id,
          pickupDepotId: pick(depots, n).id,
          status,
          scheduledAt,
          completedAt: status === JobStatus.COMPLETED ? new Date(scheduledAt.getTime() + 6 * 3_600_000) : null,
        },
      });

      const stopCount = 3 + (n % 10); // 3..12 drops per run
      const stops = Array.from({ length: stopCount }, (_, s) => {
        const customer = pick(customers, n * 7 + s);
        let outcome: StopOutcome = StopOutcome.PENDING;
        let completedAt: Date | null = null;
        let recipientName: string | null = null;
        let failureReason: StopFailureReason | null = null;
        if (status === JobStatus.COMPLETED) {
          const failed = (n + s) % 9 === 0; // ~11% fail
          outcome = failed ? StopOutcome.FAILED : StopOutcome.DELIVERED;
          completedAt = new Date(scheduledAt.getTime() + (s + 1) * 20 * 60_000);
          if (failed) failureReason = pick(FAIL_REASONS, n + s);
          else recipientName = pick(RECIPIENTS, n + s);
        }
        return {
          companyId,
          jobId: job.id,
          customerId: customer.id,
          sequence: s + 1,
          label: customer.name,
          address: customer.address,
          contactName: customer.contactName,
          outcome,
          completedAt,
          recipientName,
          failureReason,
        };
      });
      await prisma.jobStop.createMany({ data: stops });
    }
    console.log('Runs + stops created.');
  }

  // A little maintenance history (no severity — defaults).
  if ((await prisma.maintenanceJob.count({ where: { companyId } })) < 18) {
    const mstatuses = [MaintenanceJobStatus.OPEN, MaintenanceJobStatus.IN_PROGRESS, MaintenanceJobStatus.COMPLETE, MaintenanceJobStatus.COMPLETE];
    const titles = ['Brake pads front', 'Oil & filter service', 'Tyre replacement', 'Coolant leak', 'Windscreen chip', 'Battery replacement'];
    for (let i = 0; i < 18; i++) {
      const status = pick(mstatuses, i);
      await prisma.maintenanceJob.create({
        data: {
          companyId,
          assetId: pick(assets, i).id,
          title: pick(titles, i),
          status,
          partsCost: status === MaintenanceJobStatus.COMPLETE ? 80 + i * 15 : null,
          laborCost: status === MaintenanceJobStatus.COMPLETE ? 120 + i * 10 : null,
          completedAt: status === MaintenanceJobStatus.COMPLETE ? daysAgo(HISTORY_DAYS - i * 8) : null,
        },
      });
    }
    console.log('Maintenance history created.');
  }

  // Compliance docs (rego + insurance) with staggered expiries.
  if ((await prisma.complianceDocument.count({ where: { companyId } })) < assets.length * 2) {
    for (let i = 0; i < assets.length; i++) {
      const regoExisting = await prisma.complianceDocument.findFirst({ where: { companyId, assetId: assets[i].id, documentType: ComplianceDocumentType.REGISTRATION } });
      if (!regoExisting) {
        await prisma.complianceDocument.create({
          data: { companyId, assetId: assets[i].id, documentType: ComplianceDocumentType.REGISTRATION, documentNumber: `REG-${1000 + i}`, expiresAt: daysAgo(-(20 + i * 25)) },
        });
        await prisma.complianceDocument.create({
          data: { companyId, assetId: assets[i].id, documentType: ComplianceDocumentType.INSURANCE, documentNumber: `INS-${2000 + i}`, expiresAt: daysAgo(-(90 + i * 15)) },
        });
      }
    }
    console.log('Compliance documents created.');
  }

  const [aCount, jCount, sCount] = await Promise.all([
    prisma.asset.count({ where: { companyId } }),
    prisma.job.count({ where: { companyId } }),
    prisma.jobStop.count({ where: { companyId } }),
  ]);
  console.log('Done.', { companyId, assets: aCount, jobs: jCount, stops: sCount });
  console.log(`\nLogin:  username="${ADMIN_USERNAME}"  password="${DEV_PASSWORD}"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
