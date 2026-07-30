-- CreateEnum
CREATE TYPE "ComplianceDocumentType" AS ENUM ('REGISTRATION', 'INSURANCE', 'ROADWORTHY');

-- AlterEnum
ALTER TYPE "TimelineEntityType" ADD VALUE 'COMPLIANCE_DOCUMENT';

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "document_type" "ComplianceDocumentType" NOT NULL,
    "document_number" TEXT,
    "jurisdiction" TEXT NOT NULL DEFAULT 'AU',
    "issued_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compliance_documents_company_id_idx" ON "compliance_documents"("company_id");

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security: same tenant-isolation pattern as assets/operators/
-- attached_units/jobs/maintenance_jobs, using the NULLIF-wrapped session GUC
-- read from the start (see 20260713072000_fix_rls_stale_session_guc for why
-- the bare cast is wrong) rather than repeating that bug in a brand-new table.
GRANT SELECT, INSERT, UPDATE ON compliance_documents TO fleetos_app;

ALTER TABLE compliance_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON compliance_documents
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
