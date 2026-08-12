/**
 * Enterprise simulation seed — a large, realistic tenant for demos and scale
 * feel: 200 assets, 220 attached units (trailers), 190 drivers with DriverOS
 * logins, customers/depots, ~a year of delivery jobs + stops, daily pre-start
 * inspections, 1,000 completed forms, a full office↔driver message history,
 * compliance documents, and a live position on every driver so the whole fleet
 * shows on the live map right now.
 *
 * Runs as the schema-owning role (DATABASE_URL) like the other seeds, so RLS /
 * per-table GRANTs don't apply — it inserts directly with explicit companyId,
 * using batched `createMany` so even ~70k rows land in a couple of minutes.
 *
 * Idempotent-ish: if the enterprise company already exists it exits without
 * touching anything. Run against a database you're happy to add a big tenant to:
 *   npm run seed:enterprise            (from apps/api)
 *
 * Login afterwards:  admin@titan  /  fleetos-dev-password
 * Driver logins:     driver1@titan … driver190@titan  /  fleetos-dev-password
 */
import './load-env';
import { randomUUID } from 'crypto';
import { JobStatus, MessageSenderType, PrismaClient, StopOutcome } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { provisionCompany } from '../src/companies/provision-company';
import { resolveBcryptCost } from '../src/common/security/bcrypt-cost';
import { assertSafeToSeed } from './seed-guard';

assertSafeToSeed('seed-enterprise-company');

const prisma = new PrismaClient();

const COMPANY_NAME = 'Titan Freight Group';
const ADMIN_USERNAME = 'admin@titan';
const DEV_PASSWORD = 'fleetos-dev-password';

// Scale knobs.
const ASSET_COUNT = 200;
const TRAILER_COUNT = 220;
const DRIVER_COUNT = 190;
const CUSTOMER_COUNT = 60;
const DEPOT_COUNT = 12;
const FORM_SUBMISSION_COUNT = 1000;
const DAYS_OF_HISTORY = 365;
const JOBS_PER_DAY = 28; // ~10k jobs across the year
const CHECKLISTS_PER_DAY = 30; // ~11k pre-starts across the year
const MESSAGES_PER_DRIVER = 24; // ~4.5k messages of history

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- tiny helpers (this is a standalone script — Math.random is fine here) ----
function pick<T>(arr: T[], i?: number): T {
  return arr[i === undefined ? Math.floor(Math.random() * arr.length) : i % arr.length];
}
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
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
  ['Freightliner', 'Cascadia'], ['Western Star', '4800'],
];
const TRAILER_TYPES = ['Curtainsider', 'Refrigerated', 'Flatbed', 'Tautliner', 'Tanker', 'Skel', 'Drop-deck', 'B-Double Lead'];
const FIRST_NAMES = ['Jack', 'Mia', 'Liam', 'Ava', 'Noah', 'Zoe', 'Ethan', 'Ruby', 'Lucas', 'Ivy', 'Kai', 'Chloe', 'Leo', 'Grace', 'Max', 'Ella', 'Sam', 'Isla', 'Dylan', 'Aria', 'Cooper', 'Sophie', 'Hunter', 'Chelsea', 'Riley', 'Poppy', 'Jax', 'Willow', 'Beau', 'Harper'];
const LAST_NAMES = ['Nguyen', 'Smith', 'Patel', 'Jones', 'Wang', 'Brown', 'Singh', 'Wilson', 'Kaur', 'Taylor', 'Chen', 'Lee', 'Kelly', 'Murphy', 'Costa', 'Ryan', 'Baker', 'Ali', 'Hughes', 'Ward', 'Bell', 'Reed', 'Cox', 'Diaz', 'Park'];
const CUSTOMER_SUFFIX = ['Distribution', 'Wholesale', 'Retail Group', 'Logistics', 'Trading Co', 'Foods', 'Hardware', 'Industrial', 'Supplies', 'Fresh Produce'];
const SUBURBS = ['Botany', 'Dandenong', 'Acacia Ridge', 'Wingfield', 'Kewdale', 'Truganina', 'Prestons', 'Wetherill Park', 'Eastern Creek', 'Altona', 'Richlands', 'Pinkenba'];
// City hubs across Australia — drivers scatter around these so the live map looks national.
// Hub centres are deliberately biased inland (west of each coastal CBD) so the
// demo scatter below stays over land — a CBD centre plus a wide random offset
// drops half the fleet into the harbour/bay/ocean, which looks broken on the
// live map. Real GPS positions come from driver phones and are always accurate;
// this only affects the simulated Titan Freight demo dataset.
const HUBS = [
  { name: 'Sydney', lat: -33.82, lng: 150.95 }, // out toward Parramatta/Blacktown, away from the harbour
  { name: 'Melbourne', lat: -37.78, lng: 144.9 }, // inner-north/west, clear of Port Phillip Bay
  { name: 'Brisbane', lat: -27.55, lng: 152.95 }, // west of the river, clear of Moreton Bay
  { name: 'Perth', lat: -31.9, lng: 115.95 }, // east of the coast and the Swan
  { name: 'Adelaide', lat: -34.88, lng: 138.62 }, // inland of Gulf St Vincent
  { name: 'Newcastle', lat: -32.83, lng: 151.65 }, // toward Maitland, off the coast
];

/**
 * A land-safe position near a hub: a tight ~±0.07° box (~7–8 km) around the
 * inland-biased centre. Small enough that the whole cluster stays on land for
 * every hub, while still spreading trucks out so the map doesn't stack them.
 */
function scatterNearHub(hub: { lat: number; lng: number }): { lat: number; lng: number } {
  return {
    lat: hub.lat + (Math.random() - 0.5) * 0.14,
    lng: hub.lng + (Math.random() - 0.5) * 0.14,
  };
}

const PRESTART_ITEMS = [
  { id: 'lights', label: 'Lights & indicators working', type: 'pass_fail', requireNoteOnFail: false, createsFaultOnFail: true },
  { id: 'tyres', label: 'Tyres undamaged & correct pressure', type: 'pass_fail', requireNoteOnFail: true, createsFaultOnFail: true },
  { id: 'brakes', label: 'Brakes & air lines OK', type: 'pass_fail', requireNoteOnFail: true, createsFaultOnFail: true },
  { id: 'coupling', label: 'Trailer coupling secure', type: 'pass_fail_na', requireNoteOnFail: true, createsFaultOnFail: false },
  { id: 'fluids', label: 'Oil & coolant levels', type: 'pass_fail', requireNoteOnFail: false, createsFaultOnFail: false },
  { id: 'odo', label: 'Odometer reading', type: 'text', requireNoteOnFail: false, createsFaultOnFail: false },
];

const FORM_TEMPLATES = [
  {
    name: 'Incident Report',
    fields: [
      { id: 'what', label: 'What happened?', type: 'text', required: true },
      { id: 'severity', label: 'Severity', type: 'single_select', required: true, options: ['Minor', 'Moderate', 'Serious'] },
      { id: 'injuries', label: 'Any injuries?', type: 'single_select', required: true, options: ['No', 'Yes'] },
      { id: 'when', label: 'Date of incident', type: 'date', required: false },
    ],
  },
  {
    name: 'Vehicle Condition Report',
    fields: [
      { id: 'cleanliness', label: 'Cab cleanliness', type: 'single_select', required: true, options: ['Good', 'Fair', 'Poor'] },
      { id: 'damage', label: 'Any new damage noted?', type: 'text', required: false },
      { id: 'fuel', label: 'Fuel level (%)', type: 'number', required: false },
    ],
  },
  {
    name: 'Delivery Exception',
    fields: [
      { id: 'reason', label: 'Exception reason', type: 'single_select', required: true, options: ['Damaged goods', 'Short delivered', 'Customer refused', 'Access issue'] },
      { id: 'detail', label: 'Details', type: 'text', required: true },
    ],
  },
];

async function main() {
  // These accounts have a well-known default password baked into this script —
  // exactly the "default credentials" failure prisma/seed.ts guards against.
  // Refuse to run against a production database.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the enterprise seed with NODE_ENV=production — it creates default-credential accounts.');
  }
  const existing = await prisma.company.findFirst({ where: { name: COMPANY_NAME } });
  if (existing) {
    // Already seeded. Live-map positions age out after 12h, so a re-run just
    // re-stamps every driver's position to "now" — the whole fleet lights up on
    // the map again without duplicating any of the historical data.
    const stampNow = Date.now();
    const ops = await prisma.operator.findMany({
      where: { companyId: existing.id, archivedAt: null, lastLat: { not: null } },
      select: { id: true },
    });
    // Re-scatter as well as re-stamp: this rewrites any older seed's wide, in-
    // water coordinates onto the tightened land-safe hubs, so a re-run repairs
    // a fleet that was previously showing trucks in the harbour/ocean.
    for (let i = 0; i < ops.length; i++) {
      const pos = scatterNearHub(pick(HUBS, i));
      await prisma.operator.update({
        where: { id: ops[i].id },
        data: { lastLat: pos.lat, lastLng: pos.lng, lastLocationAt: new Date(stampNow - randInt(0, 45) * 60 * 1000) },
      });
    }
    console.log(`"${COMPANY_NAME}" already exists — refreshed ${ops.length} driver positions to now on land (whole fleet is live on the map again).`);
    return;
  }

  console.log(`Provisioning "${COMPANY_NAME}"…`);
  const provisioned = await prisma.$transaction((tx) =>
    provisionCompany(tx, {
      companyName: COMPANY_NAME,
      adminUsername: ADMIN_USERNAME,
      adminPassword: DEV_PASSWORD,
      adminFullName: 'Titan Operations',
      adminEmail: ADMIN_USERNAME,
    }),
  );
  const companyId = provisioned.companyId;
  const adminUserId = provisioned.adminUserId;

  const landClass = await prisma.assetClass.findFirstOrThrow({ where: { companyId: null, key: 'LAND' } });
  const driverRole = await prisma.role.findFirstOrThrow({ where: { companyId, name: 'Driver' } });
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, resolveBcryptCost()); // hash once, reuse for every driver

  // ---- Assets (trucks) ----
  console.log(`Creating ${ASSET_COUNT} assets…`);
  const assetIds: string[] = [];
  const assetRows = Array.from({ length: ASSET_COUNT }, (_, i) => {
    const id = randomUUID();
    assetIds.push(id);
    const [make, model] = pick(TRUCK_MAKES, i);
    return {
      id,
      companyId,
      assetClassId: landClass.id,
      name: `Truck ${pad(i + 1)}`,
      make,
      model,
      year: randInt(2015, 2024),
      registration: `TFG${pad(i + 1)}`,
      vin: `TFGVIN${pad(i + 1, 5)}`,
      odometer: randInt(50_000, 750_000),
      odometerUnit: 'km',
    };
  });
  await insertMany(prisma.asset, assetRows);

  // ---- Attached units (trailers) ----
  console.log(`Creating ${TRAILER_COUNT} attached units…`);
  await insertMany(
    prisma.attachedUnit,
    Array.from({ length: TRAILER_COUNT }, (_, i) => ({
      companyId,
      name: `Trailer ${pad(i + 1)}`,
      make: pick(TRAILER_TYPES, i),
      registration: `TFT${pad(i + 1)}`,
      year: randInt(2012, 2024),
    })),
  );

  // ---- Depots & customers ----
  console.log(`Creating ${DEPOT_COUNT} depots and ${CUSTOMER_COUNT} customers…`);
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
      id,
      companyId,
      // Unique (last-name, suffix) grid so no two customers collide on the
      // (company_id, lower(name)) constraint: last name cycles fastest, suffix
      // advances every full pass — 25×10 = 250 unique names, well above the count.
      name: `${LAST_NAMES[i % LAST_NAMES.length]} ${CUSTOMER_SUFFIX[Math.floor(i / LAST_NAMES.length) % CUSTOMER_SUFFIX.length]}`,
      address: `${randInt(1, 400)} ${pick(SUBURBS, i)} Rd, ${pick(SUBURBS, i + 1)}`,
      contactName: `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i + 3)}`,
      phone: `04${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`,
    };
  });
  await insertMany(prisma.customer, customerRows);

  // ---- Drivers: users → memberships → operators (with live location) ----
  console.log(`Creating ${DRIVER_COUNT} drivers with logins + live positions…`);
  const now = Date.now();
  const operatorIds: string[] = [];
  const operatorUserIds: string[] = [];
  const userRows: { id: string; username: string; passwordHash: string; fullName: string; email: string }[] = [];
  const membershipRows: { companyId: string; userId: string; roleId: string }[] = [];
  const operatorRows: {
    id: string; companyId: string; fullName: string; userId: string;
    lastLat: number; lastLng: number; lastLocationAt: Date;
  }[] = [];
  for (let i = 0; i < DRIVER_COUNT; i++) {
    const userId = randomUUID();
    const operatorId = randomUUID();
    operatorIds.push(operatorId);
    operatorUserIds.push(userId);
    const fullName = `${pick(FIRST_NAMES, i)} ${pick(LAST_NAMES, i)}`;
    const username = `driver${i + 1}@titan`;
    userRows.push({ id: userId, username, passwordHash, fullName, email: username });
    membershipRows.push({ companyId, userId, roleId: driverRole.id });
    const hub = pick(HUBS, i);
    const pos = scatterNearHub(hub);
    operatorRows.push({
      id: operatorId,
      companyId,
      fullName,
      userId,
      // scatter on land near a city hub, timestamped now so all show on the live map
      lastLat: pos.lat,
      lastLng: pos.lng,
      lastLocationAt: new Date(now - randInt(0, 45) * 60 * 1000), // 0–45 min ago
    });
  }
  await insertMany(prisma.user, userRows);
  await insertMany(prisma.companyMembership, membershipRows);
  await insertMany(prisma.operator, operatorRows);

  // ---- Inspection + form templates ----
  console.log('Creating inspection + form templates…');
  const checklistTemplateId = randomUUID();
  await prisma.checklistTemplate.create({
    data: { id: checklistTemplateId, companyId, name: 'Daily Pre-Start', appliesToAssetClassId: landClass.id, items: PRESTART_ITEMS, version: 1 },
  });
  const formTemplates: { id: string; fields: typeof FORM_TEMPLATES[number]['fields'] }[] = [];
  for (const t of FORM_TEMPLATES) {
    const id = randomUUID();
    formTemplates.push({ id, fields: t.fields });
    await prisma.formTemplate.create({ data: { id, companyId, name: t.name, fields: t.fields, version: 1 } });
  }

  // ---- A year of jobs + stops ----
  console.log('Generating a year of jobs and stops…');
  const jobRows: {
    id: string; companyId: string; title: string; assetId: string; operatorId: string | null;
    pickupDepotId: string; status: JobStatus; scheduledAt: Date; completedAt: Date | null;
  }[] = [];
  const stopRows: {
    companyId: string; jobId: string; sequence: number; label: string; customerId: string;
    address: string; outcome: StopOutcome; completedAt: Date | null; recipientName: string | null;
  }[] = [];

  for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
    const dayStart = now - d * DAY_MS;
    const isHistorical = d > 1;
    for (let j = 0; j < JOBS_PER_DAY; j++) {
      const jobId = randomUUID();
      const opIdx = randInt(0, DRIVER_COUNT - 1);
      const scheduledAt = new Date(dayStart + randInt(6, 18) * 60 * 60 * 1000);
      const status = isHistorical ? JobStatus.COMPLETED : j % 3 === 0 ? JobStatus.UNASSIGNED : JobStatus.ASSIGNED;
      jobRows.push({
        id: jobId,
        companyId,
        title: `${pick(HUBS).name} metro run #${d}-${j}`,
        assetId: pick(assetIds),
        operatorId: status === JobStatus.UNASSIGNED ? null : operatorIds[opIdx],
        pickupDepotId: pick(depotIds),
        status,
        scheduledAt,
        completedAt: status === JobStatus.COMPLETED ? new Date(scheduledAt.getTime() + 6 * 60 * 60 * 1000) : null,
      });
      const stopCount = randInt(3, 6);
      for (let s = 0; s < stopCount; s++) {
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
        stopRows.push({
          companyId,
          jobId,
          sequence: s + 1,
          label: customerRows[cIdx].name,
          customerId: customerIds[cIdx],
          address: customerRows[cIdx].address,
          outcome,
          completedAt,
          recipientName,
        });
      }
    }
  }
  // Guarantee every driver has an ASSIGNED job scheduled today, so all 190
  // markers on the live map are labelled with a truck.
  for (let i = 0; i < DRIVER_COUNT; i++) {
    jobRows.push({
      id: randomUUID(),
      companyId,
      title: `Today's run — ${operatorRows[i].fullName.split(' ')[0]}`,
      assetId: assetIds[i % assetIds.length],
      operatorId: operatorIds[i],
      pickupDepotId: pick(depotIds),
      status: JobStatus.ASSIGNED,
      scheduledAt: new Date(now + randInt(1, 8) * 60 * 60 * 1000),
      completedAt: null,
    });
  }
  console.log(`  ${jobRows.length} jobs, ${stopRows.length} stops…`);
  await insertMany(prisma.job, jobRows, 3000);
  await insertMany(prisma.jobStop, stopRows, 3000);

  // ---- Inspections (pre-start submissions) across the year ----
  console.log('Generating inspection submissions…');
  const submissionRows: {
    companyId: string; templateId: string; templateVersion: number; templateSnapshot: unknown;
    assetId: string; operatorId: string; answers: unknown; hasFailures: boolean; submittedAt: Date;
  }[] = [];
  for (let d = DAYS_OF_HISTORY; d >= 0; d--) {
    for (let k = 0; k < CHECKLISTS_PER_DAY; k++) {
      const failed = Math.random() < 0.06;
      const answers = PRESTART_ITEMS.map((it) => {
        if (it.type === 'text') return { itemId: it.id, status: null, note: String(randInt(50_000, 800_000)) };
        const status = it.id === 'tyres' && failed ? 'fail' : Math.random() < 0.02 ? 'na' : 'pass';
        return { itemId: it.id, status, note: status === 'fail' ? 'Worn tread on front-left' : null };
      });
      submissionRows.push({
        companyId,
        templateId: checklistTemplateId,
        templateVersion: 1,
        templateSnapshot: PRESTART_ITEMS,
        assetId: pick(assetIds),
        operatorId: pick(operatorIds),
        answers,
        hasFailures: failed,
        submittedAt: new Date(now - d * DAY_MS + randInt(5, 9) * 60 * 60 * 1000),
      });
    }
  }
  await insertMany(prisma.checklistSubmission, submissionRows, 3000);

  // ---- 1,000 completed forms ----
  console.log(`Generating ${FORM_SUBMISSION_COUNT} form submissions…`);
  const formRows = Array.from({ length: FORM_SUBMISSION_COUNT }, () => {
    const t = pick(formTemplates);
    const answers = t.fields
      .filter((f) => f.required || Math.random() < 0.6)
      .map((f) => {
        if (f.type === 'single_select') return { fieldId: f.id, value: pick(f.options ?? ['—']) };
        if (f.type === 'number') return { fieldId: f.id, value: randInt(0, 100) };
        if (f.type === 'date') return { fieldId: f.id, value: new Date(now - randInt(0, 300) * DAY_MS).toISOString() };
        return { fieldId: f.id, value: 'Recorded during route — logged for the office.' };
      });
    return {
      companyId,
      templateId: t.id,
      templateVersion: 1,
      templateSnapshot: t.fields,
      answers,
      submittedByUserId: pick(operatorUserIds),
      submittedAt: new Date(now - randInt(0, DAYS_OF_HISTORY) * DAY_MS),
    };
  });
  await insertMany(prisma.formSubmission, formRows, 2000);

  // ---- Full office↔driver message history ----
  console.log('Generating message history…');
  const officeLines = ['Morning — run sheet is loaded, safe driving.', 'Customer moved to a 2pm window, can you swing it?', 'Nice work on yesterday, all on time.', 'Fuel card statement is due, log your last fill.', 'Depot closes 4pm today for stocktake.', 'Please send a POD photo for the last drop.'];
  const driverLines = ['On the road, first drop done.', 'Running 15 late, traffic on the M1.', 'All delivered, heading back to depot.', 'Customer refused one carton, logged an exception.', 'Fuelled up, receipt logged.', 'Copy that, will do.'];
  const messageRows: { companyId: string; operatorId: string; senderType: MessageSenderType; senderUserId: string | null; body: string; createdAt: Date }[] = [];
  for (let i = 0; i < DRIVER_COUNT; i++) {
    const count = randInt(Math.floor(MESSAGES_PER_DRIVER * 0.5), MESSAGES_PER_DRIVER);
    for (let m = 0; m < count; m++) {
      const fromOffice = m % 2 === 0;
      messageRows.push({
        companyId,
        operatorId: operatorIds[i],
        senderType: fromOffice ? MessageSenderType.OFFICE : MessageSenderType.OPERATOR,
        senderUserId: fromOffice ? adminUserId : operatorUserIds[i],
        body: fromOffice ? pick(officeLines) : pick(driverLines),
        createdAt: new Date(now - randInt(0, 60) * DAY_MS - (count - m) * 3 * 60 * 60 * 1000),
      });
    }
  }
  await insertMany(prisma.message, messageRows, 3000);

  // ---- Compliance documents (so the Compliance position bars look real) ----
  console.log('Generating compliance documents…');
  const complianceRows: { companyId: string; assetId?: string; operatorId?: string; documentType: 'REGISTRATION' | 'INSURANCE' | 'ROADWORTHY' | 'LICENCE'; documentNumber: string; expiresAt: Date; issuedAt: Date }[] = [];
  const expiryFor = () => {
    const r = Math.random();
    // ~85% current, ~9% expiring within 30 days, ~6% expired
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

  // ---- Summary ----
  const [jobs, stops, subs, forms, msgs, docs] = await Promise.all([
    prisma.job.count({ where: { companyId } }),
    prisma.jobStop.count({ where: { companyId } }),
    prisma.checklistSubmission.count({ where: { companyId } }),
    prisma.formSubmission.count({ where: { companyId } }),
    prisma.message.count({ where: { companyId } }),
    prisma.complianceDocument.count({ where: { companyId } }),
  ]);
  console.log('\n✅ Enterprise company seeded.');
  console.log(`   Company:     ${COMPANY_NAME}`);
  console.log(`   Assets:      ${ASSET_COUNT}   Trailers: ${TRAILER_COUNT}   Drivers: ${DRIVER_COUNT} (all with logins + live positions)`);
  console.log(`   Jobs:        ${jobs}   Stops: ${stops}`);
  console.log(`   Inspections: ${subs}   Forms: ${forms}   Messages: ${msgs}   Compliance docs: ${docs}`);
  console.log(`\n   Login:  admin@titan  /  ${DEV_PASSWORD}`);
  console.log(`   Drivers: driver1@titan … driver${DRIVER_COUNT}@titan  /  ${DEV_PASSWORD}`);
  console.log('   All drivers have a live position now — open Live Map to see the whole fleet (positions age out after 12h).');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
