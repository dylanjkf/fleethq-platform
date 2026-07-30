-- Make asset categories customer-definable. Built-ins (Land/Air/Sea) become
-- shared rows with company_id = NULL, visible to every company; a company can
-- add its own categories (company_id set), each usable by checklists.

-- 1. Drop the fixed enum type on `key`, make it plain text.
ALTER TABLE "asset_classes" ALTER COLUMN "key" TYPE TEXT USING "key"::text;
DROP TYPE "AssetClassKey";

-- 2. New columns.
ALTER TABLE "asset_classes" ADD COLUMN "company_id" UUID;
ALTER TABLE "asset_classes" ADD COLUMN "description" TEXT;
ALTER TABLE "asset_classes" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "asset_classes" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "asset_classes" ADD COLUMN "archived_at" TIMESTAMP(3);

-- Existing built-ins should be usable now (drop the "only LAND implemented" gate).
UPDATE "asset_classes" SET "is_implemented" = true;

ALTER TABLE "asset_classes"
  ADD CONSTRAINT "asset_classes_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. Uniqueness: built-ins unique by key globally; company rows unique per company.
DROP INDEX IF EXISTS "asset_classes_key_key";
CREATE UNIQUE INDEX "asset_classes_builtin_key_key" ON "asset_classes" ("key") WHERE "company_id" IS NULL;
CREATE UNIQUE INDEX "asset_classes_company_key_key" ON "asset_classes" ("company_id", "key") WHERE "company_id" IS NOT NULL;
CREATE INDEX "asset_classes_company_id_idx" ON "asset_classes" ("company_id");

-- 4. RLS: a company sees the shared built-ins (company_id NULL) plus its own
-- rows, and may only write its own. Built-ins are seed-managed (the seed role
-- bypasses RLS). Mirrors the tenant_isolation pattern used elsewhere.
GRANT SELECT, INSERT, UPDATE ON asset_classes TO fleetos_app;
ALTER TABLE asset_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_classes FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_classes_read ON asset_classes FOR SELECT
  USING (company_id IS NULL OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY asset_classes_insert ON asset_classes FOR INSERT
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
CREATE POLICY asset_classes_update ON asset_classes FOR UPDATE
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
