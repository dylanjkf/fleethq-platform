-- Schema-integrity hardening (audit remediation: database).
--
-- 1. fuel_entries.company_id: CASCADE -> RESTRICT. Fuel entries are
--    financial/expense records; a company hard delete must not silently take
--    them with it. Matches the protective default already used for maintenance
--    jobs and checklist submissions (companies are soft-deleted in practice).
-- 2. compliance_documents.asset_id: SET NULL -> RESTRICT. A CHECK constraint
--    requires exactly one of asset/operator to be non-null, so nulling asset_id
--    on an asset delete would violate it with an opaque error. RESTRICT gives a
--    clean "still referenced" failure instead.
-- 3. auth_tokens.token_hash: plain index -> UNIQUE. A token hash is derived from
--    a cryptographically random secret, so it identifies exactly one issued
--    token; a unique constraint documents and enforces that invariant.

ALTER TABLE "fuel_entries" DROP CONSTRAINT "fuel_entries_company_id_fkey";
ALTER TABLE "fuel_entries"
  ADD CONSTRAINT "fuel_entries_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compliance_documents" DROP CONSTRAINT "compliance_documents_asset_id_fkey";
ALTER TABLE "compliance_documents"
  ADD CONSTRAINT "compliance_documents_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "auth_tokens_token_hash_idx";
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");
