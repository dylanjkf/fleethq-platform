-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "StopFailureReason" AS ENUM ('NOBODY_HOME', 'ACCESS_DENIED', 'BUSINESS_CLOSED', 'ADDRESS_ISSUE', 'REFUSED', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ComplianceDocumentType" ADD VALUE 'LICENCE';
ALTER TYPE "ComplianceDocumentType" ADD VALUE 'MEDICAL_CERTIFICATE';

-- AlterEnum
ALTER TYPE "TimelineEntityType" ADD VALUE 'DEPOT';

-- DropForeignKey
ALTER TABLE "compliance_documents" DROP CONSTRAINT "compliance_documents_asset_id_fkey";

-- AlterTable
ALTER TABLE "compliance_documents" ADD COLUMN     "file_attachment_id" UUID,
ADD COLUMN     "operator_id" UUID,
ALTER COLUMN "asset_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "job_stops" ADD COLUMN     "failure_reason" "StopFailureReason",
ADD COLUMN     "reattempt_of_stop_id" UUID,
ADD COLUMN     "window_end" TIMESTAMP(3),
ADD COLUMN     "window_start" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "pickup_depot_id" UUID;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "emailed_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "operator_shifts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "operator_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "depots" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "depots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operator_shifts_company_id_operator_id_idx" ON "operator_shifts"("company_id", "operator_id");

-- CreateIndex
CREATE INDEX "depots_company_id_idx" ON "depots"("company_id");

-- AddForeignKey
ALTER TABLE "operator_shifts" ADD CONSTRAINT "operator_shifts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_shifts" ADD CONSTRAINT "operator_shifts_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pickup_depot_id_fkey" FOREIGN KEY ("pickup_depot_id") REFERENCES "depots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "depots" ADD CONSTRAINT "depots_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_reattempt_of_stop_id_fkey" FOREIGN KEY ("reattempt_of_stop_id") REFERENCES "job_stops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_file_attachment_id_fkey" FOREIGN KEY ("file_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security for the two new tables (per prisma/migrations/*_add_row_level_security).
-- Both are office-editable reference records (SELECT/INSERT/UPDATE, never
-- DELETE — no hard deletes; Depot archives like Customer/AttachedUnit,
-- OperatorShift ends via status/endedAt rather than archivedAt since a shift
-- has a natural terminal lifecycle, matching the Job/MaintenanceJob pattern).
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON depots TO fleetos_app;
ALTER TABLE depots ENABLE ROW LEVEL SECURITY;
ALTER TABLE depots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON depots
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON operator_shifts TO fleetos_app;
ALTER TABLE operator_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operator_shifts
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Structural invariant: a compliance document belongs to exactly one of an
-- Asset or an Operator, never both, never neither. Enforced at the database
-- level (not just app logic) since this is a data-integrity rule, not a
-- business preference. Every pre-existing row has asset_id set and
-- operator_id null, so this is safe to add without a data migration.
-- ---------------------------------------------------------------------------

ALTER TABLE compliance_documents
  ADD CONSTRAINT compliance_document_asset_xor_operator
  CHECK (((asset_id IS NOT NULL)::int + (operator_id IS NOT NULL)::int) = 1);
