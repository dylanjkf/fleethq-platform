-- Let a company REMOVE a built-in asset category from its own account.
--
-- The built-ins (Land/Air/Sea) are single shared rows with company_id IS NULL,
-- read by every tenant. Deleting or archiving that row to satisfy one company
-- would remove the category for ALL companies, so "remove" cannot mean a delete
-- here. Instead each company keeps a suppression list: a row in this table hides
-- exactly one built-in from exactly one company, leaving the shared row intact
-- and every other tenant untouched.
--
-- Suppression is reversible by design (delete the row to restore the category) —
-- the alternative, an irreversible hide of a row the company cannot recreate
-- (the key would clash with the still-existing built-in), would be a trap.

CREATE TABLE "hidden_asset_classes" (
  "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
  "company_id"    UUID         NOT NULL,
  "asset_class_id" UUID        NOT NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hidden_asset_classes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hidden_asset_classes_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "hidden_asset_classes_asset_class_id_fkey"
    FOREIGN KEY ("asset_class_id") REFERENCES "asset_classes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- One suppression per (company, category): makes hiding idempotent and makes the
-- "is it hidden" lookup an index hit.
CREATE UNIQUE INDEX "hidden_asset_classes_company_id_asset_class_id_key"
  ON "hidden_asset_classes" ("company_id", "asset_class_id");
-- Reverse lookup for the FK, so removing a category doesn't sequential-scan.
CREATE INDEX "hidden_asset_classes_asset_class_id_idx"
  ON "hidden_asset_classes" ("asset_class_id");

-- Standard tenant isolation: a company only ever sees and writes its own
-- suppressions.
GRANT SELECT, INSERT, DELETE ON "hidden_asset_classes" TO fleetos_app;
ALTER TABLE "hidden_asset_classes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hidden_asset_classes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "hidden_asset_classes"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
