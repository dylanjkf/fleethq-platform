-- AlterEnum
ALTER TYPE "TimelineEntityType" ADD VALUE 'CUSTOMER';

-- AlterTable
ALTER TABLE "job_stops" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "signature_attachment_id" UUID;

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "contact_name" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_company_id_idx" ON "customers"("company_id");

-- CreateIndex
CREATE INDEX "job_stops_company_id_customer_id_idx" ON "job_stops"("company_id", "customer_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stops" ADD CONSTRAINT "job_stops_signature_attachment_id_fkey" FOREIGN KEY ("signature_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: customers are office-editable (SELECT/INSERT/UPDATE, never DELETE — no
-- hard deletes; archiving sets archived_at), same as Asset/Operator/AttachedUnit.
GRANT SELECT, INSERT, UPDATE ON customers TO fleetos_app;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
