/**
 * One-off seed for load testing (task #110). Creates a dedicated company
 * with a realistic data volume (hundreds of assets/jobs/maintenance jobs)
 * so autocannon runs exercise real query plans instead of empty-table scans.
 * Safe to re-run — skips if the company already exists.
 *
 * Not part of `npm run seed`; invoked directly with ts-node for this one
 * load-testing session.
 */
import './load-env';
import { PrismaClient, AssetClassKey, JobStatus, MaintenanceSeverity, MaintenanceJobStatus } from '@prisma/client';
import { provisionCompany } from '../src/companies/provision-company';
import { assertSafeToSeed } from './seed-guard';

assertSafeToSeed('seed-load-test-data');

const prisma = new PrismaClient();

const COMPANY_NAME = 'Load Test Freight Co';
const ADMIN_USERNAME = 'admin@loadtest';
const DEV_PASSWORD = 'fleetos-dev-password';

const ASSET_COUNT = 500;
const JOB_COUNT = 1000;
const MAINTENANCE_JOB_COUNT = 400;

async function main() {
  // Bulk load-test fixtures with default credentials — never against production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run the load-test seed with NODE_ENV=production.');
  }
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
        adminFullName: 'Load Test Administrator',
      }),
    );
    companyId = result.companyId;
    console.log(`Provisioned "${COMPANY_NAME}" (${companyId}).`);
  }

  const landClass = await prisma.assetClass.findUniqueOrThrow({ where: { key: AssetClassKey.LAND } });

  const existingAssetCount = await prisma.asset.count({ where: { companyId } });
  if (existingAssetCount < ASSET_COUNT) {
    const toCreate = ASSET_COUNT - existingAssetCount;
    console.log(`Creating ${toCreate} assets...`);
    await prisma.asset.createMany({
      data: Array.from({ length: toCreate }, (_, i) => ({
        companyId,
        assetClassId: landClass.id,
        name: `Load Truck ${existingAssetCount + i + 1}`,
        externalReference: `LT-${existingAssetCount + i + 1}`,
      })),
    });
  }

  const assets = await prisma.asset.findMany({ where: { companyId }, select: { id: true } });

  const existingJobCount = await prisma.job.count({ where: { companyId } });
  if (existingJobCount < JOB_COUNT) {
    const toCreate = JOB_COUNT - existingJobCount;
    console.log(`Creating ${toCreate} jobs...`);
    const statuses = [JobStatus.UNASSIGNED, JobStatus.ASSIGNED, JobStatus.COMPLETED, JobStatus.CANCELLED];
    const batchSize = 500;
    for (let start = 0; start < toCreate; start += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, toCreate - start) }, (_, i) => {
        const n = existingJobCount + start + i + 1;
        const status = statuses[n % statuses.length];
        return {
          companyId,
          title: `Load run #${n}`,
          assetId: assets[n % assets.length].id,
          status,
          scheduledAt: new Date(Date.now() - n * 60_000),
          completedAt: status === JobStatus.COMPLETED ? new Date(Date.now() - n * 30_000) : null,
        };
      });
      await prisma.job.createMany({ data: batch });
    }
  }

  const existingMaintCount = await prisma.maintenanceJob.count({ where: { companyId } });
  if (existingMaintCount < MAINTENANCE_JOB_COUNT) {
    const toCreate = MAINTENANCE_JOB_COUNT - existingMaintCount;
    console.log(`Creating ${toCreate} maintenance jobs...`);
    const severities = [MaintenanceSeverity.NORMAL, MaintenanceSeverity.CRITICAL];
    const mstatuses = [MaintenanceJobStatus.OPEN, MaintenanceJobStatus.IN_PROGRESS, MaintenanceJobStatus.PARTS_PENDING, MaintenanceJobStatus.COMPLETE];
    const batchSize = 500;
    for (let start = 0; start < toCreate; start += batchSize) {
      const batch = Array.from({ length: Math.min(batchSize, toCreate - start) }, (_, i) => {
        const n = existingMaintCount + start + i + 1;
        const status = mstatuses[n % mstatuses.length];
        return {
          companyId,
          assetId: assets[n % assets.length].id,
          title: `Load maintenance issue #${n}`,
          severity: severities[n % severities.length],
          status,
          partsCost: status === MaintenanceJobStatus.COMPLETE ? 50 + (n % 500) : null,
          laborCost: status === MaintenanceJobStatus.COMPLETE ? 40 + (n % 300) : null,
          completedAt: status === MaintenanceJobStatus.COMPLETE ? new Date(Date.now() - n * 45_000) : null,
        };
      });
      await prisma.maintenanceJob.createMany({ data: batch });
    }
  }

  const [finalAssets, finalJobs, finalMaint] = await Promise.all([
    prisma.asset.count({ where: { companyId } }),
    prisma.job.count({ where: { companyId } }),
    prisma.maintenanceJob.count({ where: { companyId } }),
  ]);
  console.log('Done.', { companyId, assets: finalAssets, jobs: finalJobs, maintenanceJobs: finalMaint });
  console.log(`Login: username="${ADMIN_USERNAME}" password="${DEV_PASSWORD}"`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
