-- Analytics controls (analytics:manage): a company can set its own target
-- percentages + colour thresholds, manually override a live dashboard figure
-- (with an audit trail + an "adjusted" marker), exclude an unrepresentative
-- day from the trend/delta, or reset the accumulated history. None of this
-- fabricates data silently — overrides are marked and every change is audited.

-- A day an authorised user has excluded from the utilisation trend + delta.
ALTER TABLE "utilisation_snapshots"
  ADD COLUMN "excluded" BOOLEAN NOT NULL DEFAULT false;

-- Per-company analytics configuration (one row; absent = platform defaults).
CREATE TABLE "analytics_settings" (
  "id"                 UUID    NOT NULL DEFAULT gen_random_uuid(),
  "company_id"         UUID    NOT NULL,
  "utilisation_target" INTEGER NOT NULL DEFAULT 80,
  "compliance_target"  INTEGER NOT NULL DEFAULT 95,
  "good_threshold"     INTEGER NOT NULL DEFAULT 95,
  "warn_threshold"     INTEGER NOT NULL DEFAULT 80,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analytics_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_settings_company_id_key" ON "analytics_settings"("company_id");
ALTER TABLE "analytics_settings"
  ADD CONSTRAINT "analytics_settings_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Manual override of a live dashboard percentage (one active per company+metric).
CREATE TABLE "analytics_overrides" (
  "id"            UUID    NOT NULL DEFAULT gen_random_uuid(),
  "company_id"    UUID    NOT NULL,
  "metric"        TEXT    NOT NULL,
  "value"         INTEGER NOT NULL,
  "note"          TEXT,
  "actor_user_id" UUID,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analytics_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analytics_overrides_company_id_metric_key" ON "analytics_overrides"("company_id", "metric");
ALTER TABLE "analytics_overrides"
  ADD CONSTRAINT "analytics_overrides_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "analytics_overrides"
  ADD CONSTRAINT "analytics_overrides_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS + runtime GRANTs, same pattern as every tenant table.
ALTER TABLE "analytics_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_settings_tenant_isolation" ON "analytics_settings"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

ALTER TABLE "analytics_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_overrides_tenant_isolation" ON "analytics_overrides"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_settings" TO fleetos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "analytics_overrides" TO fleetos_app;

-- The "reset accumulated history" control deletes snapshot rows, so the runtime
-- role now also needs DELETE on the snapshot table (originally SELECT/INSERT/UPDATE).
GRANT DELETE ON "utilisation_snapshots" TO fleetos_app;
