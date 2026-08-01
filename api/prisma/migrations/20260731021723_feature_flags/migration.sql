-- FleetHQ Internal Administration Platform — Phase 5b: feature flags
-- (21-Admin-Platform/Overview.md). `feature_flags` is global reference data
-- (no company_id, no RLS — like `announcements`); `feature_flag_overrides`
-- DOES carry tenant data and gets the standard `tenant_isolation` RLS policy
-- every other tenant table has.
--
-- Note: only the tables/indexes/foreign-keys/RLS/grants this phase actually
-- adds are included below — see admin_platform_foundation's migration.sql
-- for why the auto-generated diff's unrelated drift is excluded.

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "global_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag_overrides" (
    "id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_overrides_flag_id_company_id_key" ON "feature_flag_overrides"("flag_id", "company_id");

-- AddForeignKey
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "feature_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security on feature_flag_overrides: identical policy shape to
-- every other tenant table (see e.g. the row_level_security migration's
-- policy on `assets`).
ALTER TABLE "feature_flag_overrides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "feature_flag_overrides"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- fleetos_admin: full CRUD on both tables (BYPASSRLS, so it sees every
-- company's overrides regardless of the RLS policy above).
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flags TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_flag_overrides TO fleetos_admin;

-- fleetos_app: read-only, needed to evaluate flags on customer-facing
-- requests. `feature_flags` has no RLS (global, like `announcements`);
-- `feature_flag_overrides` is RLS-protected above, so this grant only ever
-- returns the caller's own company's override rows in practice.
GRANT SELECT ON feature_flags TO fleetos_app;
GRANT SELECT ON feature_flag_overrides TO fleetos_app;
