-- Schema-integrity remediation (audit: database), two independent fixes.
--
-- 1. compliance_documents.operator_id: SET NULL -> RESTRICT. This is the
--    asymmetric twin of the asset_id fix already applied in
--    20260731120000_schema_integrity_hardening. A CHECK constraint requires
--    exactly one of asset/operator to be non-null, so nulling operator_id on an
--    operator delete would violate it with an opaque error. RESTRICT gives a
--    clean "still referenced" failure instead, matching asset_id.
--
-- 2. feature_flag_overrides: add a company_id index. The only other index is
--    the (flag_id, company_id) composite unique, whose leading column is
--    flag_id — it cannot serve the companyId-first read pattern (the RLS tenant
--    filter and every "which overrides does this company have" lookup start
--    from company_id), forcing a sequential scan. A dedicated index fixes that.
--
-- Hand-written (not `prisma migrate dev`'s shadow-DB diff), same reasoning as
-- the surrounding hardening migrations: avoids pulling in unrelated pre-existing
-- schema drift on other tables that a full diff picks up.

ALTER TABLE "compliance_documents" DROP CONSTRAINT "compliance_documents_operator_id_fkey";
ALTER TABLE "compliance_documents"
  ADD CONSTRAINT "compliance_documents_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "feature_flag_overrides_company_id_idx" ON "feature_flag_overrides"("company_id");
