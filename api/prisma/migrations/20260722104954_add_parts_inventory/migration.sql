-- AlterEnum
ALTER TYPE "TimelineEntityType" ADD VALUE 'PART';

-- CreateTable
CREATE TABLE "parts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "part_number" TEXT,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "unit_cost" DOUBLE PRECISION,
    "low_stock_threshold" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_job_part_usages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "maintenance_job_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_cost_at_use" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_job_part_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parts_company_id_idx" ON "parts"("company_id");

-- CreateIndex
CREATE INDEX "maintenance_job_part_usages_company_id_idx" ON "maintenance_job_part_usages"("company_id");

-- CreateIndex
CREATE INDEX "maintenance_job_part_usages_maintenance_job_id_idx" ON "maintenance_job_part_usages"("maintenance_job_id");

-- AddForeignKey
ALTER TABLE "parts" ADD CONSTRAINT "parts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_job_part_usages" ADD CONSTRAINT "maintenance_job_part_usages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_job_part_usages" ADD CONSTRAINT "maintenance_job_part_usages_maintenance_job_id_fkey" FOREIGN KEY ("maintenance_job_id") REFERENCES "maintenance_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_job_part_usages" ADD CONSTRAINT "maintenance_job_part_usages_part_id_fkey" FOREIGN KEY ("part_id") REFERENCES "parts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (hand-written, per prisma/migrations/*_add_row_level_security).
-- parts is office-editable (SELECT/INSERT/UPDATE, never DELETE — archiving
-- sets archived_at, and stock adjustments are an UPDATE). Usage log lines are
-- append-only and immutable (SELECT/INSERT only), same shape as checklist
-- submissions/timeline events.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON parts TO fleetos_app;

ALTER TABLE parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parts
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT ON maintenance_job_part_usages TO fleetos_app;

ALTER TABLE maintenance_job_part_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_job_part_usages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON maintenance_job_part_usages
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
