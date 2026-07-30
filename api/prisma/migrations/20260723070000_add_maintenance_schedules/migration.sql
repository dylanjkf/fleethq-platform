-- Maintenance schedules: savable templates (a "layout") + per-asset plans
-- deployed from them. Time-based in v1; feeds the asset health score.

CREATE TABLE "maintenance_schedule_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "items" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "maintenance_schedule_templates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "maintenance_schedule_templates_company_id_idx" ON "maintenance_schedule_templates"("company_id");
ALTER TABLE "maintenance_schedule_templates" ADD CONSTRAINT "maintenance_schedule_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "asset_maintenance_plans" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "template_id" UUID,
    "label" TEXT NOT NULL,
    "interval_days" INTEGER NOT NULL,
    "last_service_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "asset_maintenance_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "asset_maintenance_plans_company_id_idx" ON "asset_maintenance_plans"("company_id");
CREATE INDEX "asset_maintenance_plans_asset_id_idx" ON "asset_maintenance_plans"("asset_id");
ALTER TABLE "asset_maintenance_plans" ADD CONSTRAINT "asset_maintenance_plans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_maintenance_plans" ADD CONSTRAINT "asset_maintenance_plans_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_maintenance_plans" ADD CONSTRAINT "asset_maintenance_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "maintenance_schedule_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: tenant-scoped, mutable (no DELETE — archive instead).
GRANT SELECT, INSERT, UPDATE ON maintenance_schedule_templates TO fleetos_app;
ALTER TABLE maintenance_schedule_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_schedule_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON maintenance_schedule_templates
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON asset_maintenance_plans TO fleetos_app;
ALTER TABLE asset_maintenance_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_maintenance_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_maintenance_plans
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
