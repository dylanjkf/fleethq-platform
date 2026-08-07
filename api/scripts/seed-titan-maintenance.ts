/*
 * Supplemental seed: workshop/maintenance jobs for the enterprise simulation
 * tenant. The base enterprise seed (seed-enterprise-company.ts) populates
 * assets, operators, jobs, inspections and compliance, but leaves the workshop
 * queue empty — so the Maintenance screen and the dashboard's workshop tiles
 * render an empty state. This backfills a realistic spread of jobs across the
 * OPEN -> IN_PROGRESS -> PARTS_PENDING -> COMPLETE lifecycle so those screens
 * reflect a live transport fleet. Idempotent: skips if jobs already exist.
 */
import { PrismaClient, MaintenanceJobStatus } from '@prisma/client';

const prisma = new PrismaClient();

const COMPANY_NAME = 'Titan Freight Group';

// Realistic heavy-vehicle / trailer workshop jobs for a linehaul fleet.
const TITLES: readonly string[] = [
  'Front axle brake pad replacement',
  'Engine oil & filter service',
  'Coolant leak — investigate & repair',
  'Rear suspension airbag replacement',
  'DPF regeneration fault diagnosis',
  'Drive axle tyre replacement',
  'Clutch judder diagnosis',
  'Air-conditioning recharge',
  'Front-end wheel alignment',
  'Turbo actuator fault',
  'Gearbox oil leak repair',
  'EBS warning light diagnosis',
  'Fifth wheel greasing & inspection',
  'Handbrake linkage adjustment',
  'Trailer light board repair',
  'Reversing camera replacement',
  'Cab door seal replacement',
  'Starter battery replacement',
  'Windscreen chip repair',
  'Fuel sender unit fault',
  'Prime mover 100,000 km service',
  'Steer tyre replacement — nearside',
  'Exhaust bracket weld repair',
  'Cab suspension bush replacement',
  'ABS sensor fault — trailer axle 2',
];

const DESCRIPTIONS: readonly string[] = [
  'Reported at pre-start. Booked into workshop.',
  'Scheduled service reached on odometer trigger.',
  'Driver reported during linehaul run.',
  'Flagged on inspection failure.',
  'Recurring fault — second occurrence this quarter.',
];

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length] as T;
}

async function main() {
  const company = await prisma.company.findFirst({ where: { name: COMPANY_NAME } });
  if (!company) {
    throw new Error(`Company "${COMPANY_NAME}" not found — run the enterprise seed first.`);
  }

  const existing = await prisma.maintenanceJob.count({ where: { companyId: company.id } });
  if (existing > 0) {
    console.log(`Maintenance jobs already present (${existing}) for ${COMPANY_NAME} — skipping.`);
    return;
  }

  const assets = await prisma.asset.findMany({
    where: { companyId: company.id, archivedAt: null },
    orderBy: { name: 'asc' },
    take: 60,
    select: { id: true },
  });
  if (assets.length === 0) throw new Error('No assets found for company.');

  const operators = await prisma.operator.findMany({
    where: { companyId: company.id },
    take: 30,
    select: { id: true },
  });

  // Deterministic status spread that mirrors a working fleet: a live workshop
  // has more open/active work than closed-this-week, plus a tail of completed
  // history. 25 jobs total.
  const plan: { status: MaintenanceJobStatus; count: number }[] = [
    { status: MaintenanceJobStatus.OPEN, count: 8 },
    { status: MaintenanceJobStatus.IN_PROGRESS, count: 6 },
    { status: MaintenanceJobStatus.PARTS_PENDING, count: 3 },
    { status: MaintenanceJobStatus.COMPLETE, count: 8 },
  ];

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  let i = 0;

  for (const { status, count } of plan) {
    for (let n = 0; n < count; n++, i++) {
      const asset = pick(assets, i);
      const operator = operators.length ? pick(operators, i) : null;
      const createdAt = new Date(now - (i + 1) * 2 * day);

      const isComplete = status === MaintenanceJobStatus.COMPLETE;
      // Some active jobs are approved (past the approval gate), matching a real
      // queue where a supervisor has signed off the bigger jobs.
      const approved = isComplete || i % 3 === 0;

      await prisma.maintenanceJob.create({
        data: {
          companyId: company.id,
          assetId: asset.id,
          title: pick(TITLES, i),
          description: pick(DESCRIPTIONS, i),
          status,
          reportedByOperatorId: operator?.id ?? null,
          createdAt,
          updatedAt: createdAt,
          approvedAt: approved ? new Date(createdAt.getTime() + 2 * 60 * 60 * 1000) : null,
          approvedByUserId: null,
          completedAt: isComplete ? new Date(createdAt.getTime() + 1 * day) : null,
          partsCost: isComplete ? 120 + (i % 7) * 85 : null,
          laborCost: isComplete ? 180 + (i % 5) * 60 : null,
          resolutionNotes: isComplete ? 'Repaired, tested and returned to service.' : null,
        },
      });
    }
  }

  const total = await prisma.maintenanceJob.count({ where: { companyId: company.id } });
  console.log(`Seeded ${total} maintenance jobs for ${COMPANY_NAME}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
