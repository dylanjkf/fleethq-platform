/**
 * Production-safe Titan demo seed.
 *
 * Unlike `seed-enterprise-company.ts` (which bakes in a well-known dev password
 * for ~191 accounts and is hard-blocked from production by `seed-guard.ts`),
 * this script is safe to run against the LIVE database so you can click around a
 * realistic fleet in the real product. It is safe by construction:
 *
 *   - No default credentials. Exactly ONE login is created — the demo admin —
 *     and its password must be supplied (TITAN_ADMIN_PASSWORD) or is generated
 *     strong-and-random and printed once. Drivers are seeded as operators with
 *     NO login accounts (Operator.userId is null), so nothing weak-and-guessable
 *     ever lands in production.
 *   - Its own tenant. Everything is one company ("Titan Freight Group (Demo)"),
 *     isolated from every other org by the same row-level security the product
 *     uses. Deleting the company removes the demo cleanly.
 *   - Explicit opt-in. Refuses to run unless TITAN_DEMO_CONFIRM=SEED_TITAN_DEMO,
 *     so it can never fire by accident from a stray shell.
 *
 * It also seeds fuel purchases and completed maintenance with costs, so the
 * per-asset "Running cost" card on the asset detail page shows real numbers.
 *
 * Run locally against a disposable DB, or against production via the
 * "Seed Titan demo" GitHub Actions workflow (which injects the Railway env).
 *
 *   TITAN_DEMO_CONFIRM=SEED_TITAN_DEMO TITAN_ADMIN_PASSWORD='…' \
 *     npm --prefix api run seed:titan:demo
 */
import './load-env';
import { randomUUID, randomBytes } from 'crypto';
import { JobStatus, MaintenanceJobStatus, MessageSenderType, Prisma, PrismaClient, StopOutcome } from '@prisma/client';
import { provisionCompany } from '../src/companies/provision-company';

const prisma = new PrismaClient();

const COMPANY_NAME = 'Titan Freight Group (Demo)';
const ADMIN_USERNAME = process.env.TITAN_ADMIN_USERNAME ?? 'admin@titan';

// Scale knobs — deliberately smaller than the enterprise seed so a production
// run finishes in well under a minute while still feeling like a real fleet.
const ASSET_COUNT = 40;
const TRAILER_COUNT = 30;
const DRIVER_COUNT = 30;
const CUSTOMER_COUNT = 30;
const DEPOT_COUNT = 8;
const DAYS_OF_HISTORY = 180;
const JOBS_PER_DAY = 12;
const CHECKLISTS_PER_DAY = 12;
const FUEL_FILLS_PER_ASSET = 22; // ~ fortnightly over the last year
const MAINTENANCE_JOBS_PER_ASSET = 3; // completed, with costs, across the year

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- gate: prod-safe by construction, but still explicit opt-in ----
function requireConfirmation(): void {
  if (process.env.TITAN_DEMO_CONFIRM !== 'SEED_TITAN_DEMO') {
    throw new Error(
      'Refusing to run: set TITAN_DEMO_CONFIRM=SEED_TITAN_DEMO to seed the Titan demo tenant. ' +
        'This is the deliberate opt-in so the seed never fires by accident.',
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Refusing to run: DATABASE_URL is not set.');
  }
}

/** A strong random password (used when TITAN_ADMIN_PASSWORD is not supplied). */
function generatePassword(): string {
  // 24 url-safe chars ≈ 140 bits — comfortably strong, printed once below.
  return randomBytes(18).toString('base64url');
}

/** Reject anything too weak to sit on a production login. */
function resolveAdminPassword(): { password: string; generated: boolean } {
  const supplied = process.env.TITAN_ADMIN_PASSWORD;
  if (supplied && supplied.length > 0) {
    if (supplied.length < 12) {
      throw new Error('TITAN_ADMIN_PASSWORD is too weak — use at least 12 characters for a production login.');
    }
    return { password: supplied, generated: false };
  }
  return { password: generatePassword(), generated: true };
}

// ---- tiny helpers (standalone script — Math.random is fine here) ----
function pick<T>(arr: T[], i?: number): T {
  return arr[i === undefined ? Math.floor(Math.random() * arr.length) : i % arr.length];
}
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function pad(n: number, width = 3): string {
  return String(n).padStart(width, '0');
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
async function insertMany<T>(model: { createMany: (a: { data: T[] }) => Promise<unknown> }, rows: T[], batch = 2000) {
  for (const c of chunk(rows, batch)) await model.createMany({ data: c });
}

// ---- reference data ----
const TRUCK_MAKES = [
  ['Kenworth', 'T610'], ['Volvo', 'FH16'], ['Scania', 'R500'], ['Isuzu', 'Giga'],
  ['Mercedes-Benz', 'Actros'], ['MAN', 'TGX'], ['DAF', 'CF'], ['Hino', '700'],
];
const TRAILER_TYPES = ['Curtainsider', 'Refrigerated', 'Flatbed', 'Tautliner', 'Tanker', 'Skel', 'Drop-deck'];
const FIRST_NAMES = ['Jack', 'Mia', 'Liam', 'Ava', 'Noah', 'Zoe', 'Ethan', 'Ruby', 'Lucas', 'Ivy', 'Kai', 'Chloe', 'Leo', 'Grace', 'Max', 'Ella', 'Sam', 'Isla', 'Dylan', 'Aria'];
const LAST_NAMES = ['Nguyen', 'Smith', 'Patel', 'Jones', 'Wang', 'Brown', 'Singh', 'Wilson', 'Kaur', 'Taylor', 'Chen', 'Lee', 'Kelly', 'Murphy', 'Costa', 'Ryan', 'Baker', 'Ali', 'Hughes', 'Ward'];
const CUSTOMER_SUFFIX = ['Distribution', 'Wholesale', 'Retail Group', 'Logistics', 'Trading Co', 'Foods', 'Hardware', 'Industrial', 'Supplies', 'Fresh Produce'];
const SUBURBS = ['Botany', 'Dandenong', 'Acacia Ridge', 'Wingfield', 'Kewdale', 'Truganina', 'Prestons', 'Wetherill Park', 'Eastern Creek', 'Altona', 'Richlands', 'Pinkenba'];
const HUBS = [
  { name: 'Sydney', lat: -33.82, lng: 150.95 },
  { name: 'Melbourne', lat: -37.78, lng: 144.9 },
  { name: 'Brisbane', lat: -27.55, lng: 152.95 },
  { name: 'Perth', lat: -31.9, lng: 115.95 },
  { name: 'Adelaide', lat: -34.88, lng: 138.62 },
  { name: 'Newcastle', lat: -32.83, lng: 151.65 },
];
function scatterNearHub(hub: { lat: number; lng: number }): { lat: number; lng: number } {
  return { lat: hub.lat + (Math.random() - 0.5) * 0.14, lng: hub.lng + (Math.random() - 0.5) * 0.14 };
}
const PRESTART_ITEMS = [
  { id: 'lights', label: 'Lights & indicators working', type: 'pass_fail', requireNoteOnFail: false, createsFaultOnFail: true },
  { id: 'tyres', label: 'Tyres undamaged & correct pressure', type: 'pass_fail', requireNoteOnFail: true, createsFaultOnFail: true },
  { id: 'brakes', label: 'Brakes & air lines OK', type: 'pass_fail', requireNoteOnFail: true, createsFaultOnFail: true },
  { id: 'coupling', label: 'Trailer coupling secure', type: 'pass_fail_na', requireNoteOnFail: true, createsFaultOnFail: false },
  { id: 'fluids', label: 'Oil & coolant levels', type: 'pass_fail', requireNoteOnFail: false, createsFaultOnFail: false },
  { id: 'odo', label: 'Odometer reading', type: 'text', requireNoteOnFail: false, createsFaultOnFail: false },
];
const MAINT_TITLES = ['A-service', 'B-service', 'Brake overhaul', 'Tyre replacement', 'Clutch repair', 'Cooling system', 'Suspension work', 'DPF clean'];

async function refreshExisting(companyId: string): Promise<void> {
  // Live-map positions age out after 12h; a re-run re-stamps every operator's
  // position to now so the whole demo fleet lights up again, without touching
  // any historical data.
  const stampNow = Date.now();
  const ops = await prisma.operator.findMany({ where: { companyId, archivedAt: null, lastLat: { not: null } }, select: { id: true } });
  for (let i = 0; i < ops.length; i++) {
    const pos = scatterNearHub(pick(HUBS, i));
    await prisma.operator.update({
      where: { id: ops[i].id },
      data: { lastLat: pos.lat, lastLng: pos.lng, lastLocationAt: new Date(stampNow - randInt(0, 45) * 60 * 1000) },
    });
  }
  console.log(`"${COMPANY_NAME}" already exists — refreshed ${ops.length} operator positions to now. Nothing else changed.`);
  console.log(`Log in as ${ADMIN_USERNAME} (password unchanged from when it was first seeded).`);
}

async function main() {
  requireConfirmation();
  const { password: adminPassword, generated } = resolveAdminPassword();

  const existing = await prisma.company.findFirst({ where: { name: COMPANY_NAME } });
  if (existing) {
    await refreshExisting(existing.id);
    return;
  }

  console.log(`Provisioning "${COMPANY_NAME}"…`);
  const provisioned = await prisma.$transaction((tx) =>
    provisionCompany(tx, {
      companyName: COMPANY_NAME,
      adminUsername: ADMIN_USERNAME,
      adminPassword,
      adminFullName: 'Titan Operations',
      adminEmail: ADMIN_USERNAME,
    }),
  );
  const companyId = provisioned.companyId;
  const adminUserId = provisioned.adminUserId;
  const now = Date.now();

  const landClass = await prisma.assetClass.findFirstOrThrow({ where: { companyId: null, key: 'LAND' } });

  // ---- Assets ----
  console.log(`Creating ${ASSET_COUNT} assets…`);
  const assetIds: string[] = [];
  const assetPlates: string[] = [];
  const assetRows = Array.from({ length: ASSET_COUNT }, (_, i) => {
    const id = randomUUID();
    assetIds.push(id);
    const registration = `TFG${pad(i + 1)}`;
    assetPlates.push(registration);
    const [make, model] = pick(TRUCK_MAKES, i);
    return {
      id, companyId, assetClassId: landClass.id, name: `Truck ${pad(i + 1)}`,
      make, model, year: randInt(2015, 2024), registration, vin: `TFGDVIN${pad(i + 1, 5)}`,
      odometer: randInt(50_000, 750_000), odometerUnit: 'km',
    };
  });
  await insertMany(prisma.asset, assetRows);

  // ---- Attached units (trailers) ----
  await insertMany(
    prisma.attachedUnit,
    Array.from({ length: TRAILER_COUNT }, (_, i) => ({
      companyId, name: `Trailer ${pad(i + 1)}`, make: pick(TRAILER_TYPES, i), registration: `TFT${pad(i + 1)}`, year: randInt(2012, 2024),
    })),
  );

  // ---- Depots & customers ----
  const depotIds: string[] = [];
  await insertMany(
    prisma.depot,
    HUBS.concat(HUBS).slice(0, DEPOT_COUNT).map((hub, i) => {
      const id = randomUUID();
      depotIds.push(id);
      return { id, companyId, name: `${hub.name} Depot ${i < HUBS.length ? '' : '2'}`.trim(), address: `${hub.name}, Australia` };
    }),
  );
  const customerIds: string[] = [];
  const customerRows = Array.from({ length: CUSTOMER_COUNT }, (_, i) => {
    const id = randomUUID();
    customerIds.push(id);
    return {
      id, companyId,
      name: `${LAST_NAMES[i % LAST_NAMES.length]} ${CUSTOMER_SUFFIX[Math.floor(i / LAST_NAMES.length) % CUSTOMER_SUFFIX.length]}`,
      address: `${randInt(1, 400)} ${pick(SUBURBS, i)} Rd, ${pick(SUBURBS, i + 1)}`,
      contactName: `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i + 3)}`,
      phone: `04${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`,
    };
  });
  await insertMany(prisma.customer, customerRows);

  // ---- Drivers as operators WITHOUT login accounts (userId stays null) ----
  console.log(`Creating ${DRIVER_COUNT} drivers (operators, no logins) with live positions…`);
  const operatorIds: string[] = [];
  const operatorNames: string[] = [];
  const operatorRows = Array.from({ length: DRIVER_COUNT }, (_, i) => {
    const id = randomUUID();
    operatorIds.push(id);
    const fullName = `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i)}`;
    operatorNames.push(fullName);
    const pos = scatterNearHub(pick(HUBS, i));
    return {
      id, companyId, fullName, userId: null as string | null,
      lastLat: pos.lat, lastLng: pos.lng, lastLocationAt: new Date(now - randInt(0, 45) * 60 * 1000),
    };
  });
  await insertMany(prisma.operator, operatorRows);

  // ---- Inspection template ----
  const checklistTemplateId = randomUUID();
  await prisma.checklistTemplate.create({
    data: { id: checklistTemplateId, companyId, name: 'Daily Pre-Start', appliesToAssetClassId: landClass.id, items: PRESTART_ITEMS, version: 1 },
  });

  // ---- Jobs + stops ----
  console.log('Generating jobs and stops…');
  const jobRows: { id: string; companyId: string; title: string; assetId: string; operatorId: string | null; pickupDepotId: string; status: JobStatus; scheduledAt: Date; completedAt: Date | null }[] = [];
  const stopRows: { companyId: string; jobId: string; sequence: number; label: string; customerId: string; address: string; outcome: StopOutcome; completedAt: Date | null; recipientName: string | null }[] = [];
  for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
    const dayStart = now - d * DAY_MS;
    const isHistorical = d > 1;
    for (let j = 0; j < JOBS_PER_DAY; j++) {
      const jobId = randomUUID();
      const scheduledAt = new Date(dayStart + randInt(6, 18) * 60 * 60 * 1000);
      const status = isHistorical ? JobStatus.COMPLETED : j % 3 === 0 ? JobStatus.UNASSIGNED : JobStatus.ASSIGNED;
      jobRows.push({
        id: jobId, companyId, title: `${pick(HUBS).name} metro run #${d}-${j}`,
        assetId: pick(assetIds), operatorId: status === JobStatus.UNASSIGNED ? null : pick(operatorIds),
        pickupDepotId: pick(depotIds), status, scheduledAt,
        completedAt: status === JobStatus.COMPLETED ? new Date(scheduledAt.getTime() + 6 * 60 * 60 * 1000) : null,
      });
      for (let s = 0; s < randInt(3, 6); s++) {
        const cIdx = randInt(0, CUSTOMER_COUNT - 1);
        let outcome: StopOutcome = StopOutcome.PENDING;
        let completedAt: Date | null = null;
        let recipientName: string | null = null;
        if (status === JobStatus.COMPLETED) {
          const failed = Math.random() < 0.08;
          outcome = failed ? StopOutcome.FAILED : StopOutcome.DELIVERED;
          completedAt = new Date(scheduledAt.getTime() + s * 40 * 60 * 1000);
          recipientName = failed ? null : `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
        }
        stopRows.push({ companyId, jobId, sequence: s + 1, label: customerRows[cIdx].name, customerId: customerIds[cIdx], address: customerRows[cIdx].address, outcome, completedAt, recipientName });
      }
    }
  }
  // Give every operator an ASSIGNED job today so the whole fleet is labelled on the live map.
  for (let i = 0; i < DRIVER_COUNT; i++) {
    jobRows.push({
      id: randomUUID(), companyId, title: `Today's run — ${operatorNames[i].split(' ')[0]}`,
      assetId: assetIds[i % assetIds.length], operatorId: operatorIds[i], pickupDepotId: pick(depotIds),
      status: JobStatus.ASSIGNED, scheduledAt: new Date(now + randInt(1, 8) * 60 * 60 * 1000), completedAt: null,
    });
  }
  console.log(`  ${jobRows.length} jobs, ${stopRows.length} stops…`);
  await insertMany(prisma.job, jobRows, 3000);
  await insertMany(prisma.jobStop, stopRows, 3000);

  // ---- Pre-start inspections ----
  console.log('Generating inspection submissions…');
  const submissionRows: { companyId: string; templateId: string; templateVersion: number; templateSnapshot: Prisma.InputJsonValue; assetId: string; operatorId: string; answers: Prisma.InputJsonValue; hasFailures: boolean; submittedAt: Date }[] = [];
  for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
    for (let k = 0; k < CHECKLISTS_PER_DAY; k++) {
      const failed = Math.random() < 0.06;
      const answers = PRESTART_ITEMS.map((it) => {
        if (it.type === 'text') return { itemId: it.id, status: null, note: String(randInt(50_000, 800_000)) };
        const status = it.id === 'tyres' && failed ? 'fail' : Math.random() < 0.02 ? 'na' : 'pass';
        return { itemId: it.id, status, note: status === 'fail' ? 'Worn tread on front-left' : null };
      });
      submissionRows.push({ companyId, templateId: checklistTemplateId, templateVersion: 1, templateSnapshot: PRESTART_ITEMS, assetId: pick(assetIds), operatorId: pick(operatorIds), answers, hasFailures: failed, submittedAt: new Date(now - d * DAY_MS + randInt(5, 9) * 60 * 60 * 1000) });
    }
  }
  await insertMany(prisma.checklistSubmission, submissionRows, 3000);

  // ---- Fuel purchases (so the asset "Running cost" card shows real fuel spend) ----
  console.log('Generating fuel purchases…');
  const fuelRows: { companyId: string; assetId: string; odometerReading: number; licencePlate: string; cardLast4: string; litres: number; totalCost: number; filledAt: Date }[] = [];
  assetIds.forEach((assetId, i) => {
    let odo = randInt(50_000, 500_000);
    for (let f = 0; f < FUEL_FILLS_PER_ASSET; f++) {
      const daysAgo = Math.floor((f / FUEL_FILLS_PER_ASSET) * 360) + randInt(0, 6);
      odo += randInt(1200, 3200);
      const litres = randInt(280, 620);
      const pricePerLitre = 1.8 + Math.random() * 0.6; // ~AUD diesel
      fuelRows.push({
        companyId, assetId, odometerReading: odo, licencePlate: assetPlates[i], cardLast4: pad(randInt(0, 9999), 4),
        litres: round2(litres), totalCost: round2(litres * pricePerLitre), filledAt: new Date(now - daysAgo * DAY_MS),
      });
    }
  });
  await insertMany(prisma.fuelEntry, fuelRows, 3000);

  // ---- Completed maintenance with costs (the other half of the running cost) ----
  console.log('Generating completed maintenance jobs…');
  const maintRows: { id: string; companyId: string; assetId: string; title: string; description: string; status: MaintenanceJobStatus; partsCost: number; laborCost: number; completedAt: Date; createdAt: Date }[] = [];
  assetIds.forEach((assetId) => {
    for (let m = 0; m < MAINTENANCE_JOBS_PER_ASSET; m++) {
      const daysAgo = randInt(5, 350);
      const completedAt = new Date(now - daysAgo * DAY_MS);
      maintRows.push({
        id: randomUUID(), companyId, assetId, title: pick(MAINT_TITLES),
        description: 'Scheduled workshop visit — parts and labour recorded at close.',
        status: MaintenanceJobStatus.COMPLETE, partsCost: round2(randInt(150, 2400) + Math.random()), laborCost: round2(randInt(120, 1600) + Math.random()),
        completedAt, createdAt: new Date(completedAt.getTime() - randInt(1, 5) * DAY_MS),
      });
    }
  });
  await insertMany(prisma.maintenanceJob, maintRows, 3000);

  // ---- Compliance documents ----
  console.log('Generating compliance documents…');
  const complianceRows: { companyId: string; assetId?: string; operatorId?: string; documentType: 'REGISTRATION' | 'INSURANCE' | 'ROADWORTHY' | 'LICENCE'; documentNumber: string; expiresAt: Date; issuedAt: Date }[] = [];
  const expiryFor = () => {
    const r = Math.random();
    if (r < 0.06) return new Date(now - randInt(1, 60) * DAY_MS);
    if (r < 0.15) return new Date(now + randInt(1, 29) * DAY_MS);
    return new Date(now + randInt(40, 400) * DAY_MS);
  };
  assetIds.forEach((assetId, i) => {
    for (const documentType of ['REGISTRATION', 'INSURANCE', 'ROADWORTHY'] as const) {
      complianceRows.push({ companyId, assetId, documentType, documentNumber: `${documentType.slice(0, 3)}-${pad(i + 1, 4)}`, expiresAt: expiryFor(), issuedAt: new Date(now - randInt(60, 720) * DAY_MS) });
    }
  });
  operatorIds.forEach((operatorId, i) => {
    complianceRows.push({ companyId, operatorId, documentType: 'LICENCE', documentNumber: `LIC-${pad(i + 1, 5)}`, expiresAt: expiryFor(), issuedAt: new Date(now - randInt(60, 1400) * DAY_MS) });
  });
  await insertMany(prisma.complianceDocument, complianceRows, 3000);

  // ---- A little office→driver message history (office-originated; no driver logins) ----
  const officeLines = ['Morning — run sheet is loaded, safe driving.', 'Customer moved to a 2pm window.', 'Nice work yesterday, all on time.', 'Depot closes 4pm today for stocktake.', 'Please send a POD photo for the last drop.'];
  const messageRows = operatorIds.slice(0, 15).flatMap((operatorId) =>
    Array.from({ length: randInt(2, 5) }, (_, m) => ({
      companyId, operatorId, senderType: MessageSenderType.OFFICE, senderUserId: adminUserId,
      body: pick(officeLines), createdAt: new Date(now - randInt(0, 30) * DAY_MS - m * 3 * 60 * 60 * 1000),
    })),
  );
  await insertMany(prisma.message, messageRows, 2000);

  // ---- Summary ----
  const [jobs, fuel, maint] = await Promise.all([
    prisma.job.count({ where: { companyId } }),
    prisma.fuelEntry.count({ where: { companyId } }),
    prisma.maintenanceJob.count({ where: { companyId } }),
  ]);
  console.log('\n✅ Titan demo tenant seeded.');
  console.log(`   Company:  ${COMPANY_NAME}`);
  console.log(`   Assets: ${ASSET_COUNT}   Drivers (operators, no login): ${DRIVER_COUNT}   Jobs: ${jobs}`);
  console.log(`   Fuel purchases: ${fuel}   Completed maintenance jobs: ${maint}  →  the asset "Running cost" card will show real numbers.`);
  console.log('\n   ── Log in to the real app ──');
  console.log(`   Username: ${ADMIN_USERNAME}`);
  if (generated) {
    console.log(`   Password: ${adminPassword}`);
    console.log('   ^ Generated for you — copy it now; it is not stored anywhere and will not be shown again.');
  } else {
    console.log('   Password: (the TITAN_ADMIN_PASSWORD you supplied)');
  }
  console.log('\n   To remove the demo later: delete the company above (it is fully tenant-isolated).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
