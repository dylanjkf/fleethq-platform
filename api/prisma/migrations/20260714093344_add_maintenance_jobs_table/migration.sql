-- CreateEnum
CREATE TYPE "MaintenanceJobStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'PARTS_PENDING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "MaintenanceSeverity" AS ENUM ('NORMAL', 'CRITICAL');

-- AlterEnum
ALTER TYPE "TimelineEntityType" ADD VALUE 'MAINTENANCE_JOB';

-- CreateTable
CREATE TABLE "maintenance_jobs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "MaintenanceSeverity" NOT NULL DEFAULT 'NORMAL',
    "status" "MaintenanceJobStatus" NOT NULL DEFAULT 'OPEN',
    "reported_by_operator_id" UUID,
    "resolution_notes" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "maintenance_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_jobs_company_id_idx" ON "maintenance_jobs"("company_id");

-- AddForeignKey
ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "maintenance_jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "maintenance_jobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "maintenance_jobs_reported_by_operator_id_fkey" FOREIGN KEY ("reported_by_operator_id") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_jobs" ADD CONSTRAINT "maintenance_jobs_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security: same tenant-isolation pattern as assets/operators/
-- attached_units/jobs, using the NULLIF-wrapped session GUC read from the
-- start (see 20260713072000_fix_rls_stale_session_guc for why the bare cast
-- is wrong) rather than repeating that bug in a brand-new table.
GRANT SELECT, INSERT, UPDATE ON maintenance_jobs TO fleetos_app;

ALTER TABLE maintenance_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON maintenance_jobs
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
