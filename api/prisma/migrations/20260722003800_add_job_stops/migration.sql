-- CreateEnum
CREATE TYPE "StopOutcome" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "job_stops" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT,
    "contact_name" TEXT,
    "outcome" "StopOutcome" NOT NULL DEFAULT 'PENDING',
    "completed_at" TIMESTAMP(3),
    "recipient_name" TEXT,
    "note" TEXT,
    "pod_attachment_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_stops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_stops_company_id_job_id_idx" ON "job_stops"("company_id", "job_id");

-- AddForeignKey
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_pod_attachment_id_fkey" FOREIGN KEY ("pod_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: job stops are tenant-scoped and mutable (outcome set on completion), so
-- the app role gets SELECT/INSERT/UPDATE (never DELETE — no hard deletes).
GRANT SELECT, INSERT, UPDATE ON job_stops TO fleetos_app;
ALTER TABLE job_stops ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_stops FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_stops
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
