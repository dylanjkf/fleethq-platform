-- Warehouse machine maintenance schedules: the savable/deployable plan pattern
-- (mirror of asset_maintenance_plans) targeting a warehouse machine.
CREATE TABLE "warehouse_machine_plans" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "template_id" UUID,
    "label" TEXT NOT NULL,
    "interval_days" INTEGER NOT NULL,
    "last_service_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "warehouse_machine_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "warehouse_machine_plans_company_id_idx" ON "warehouse_machine_plans"("company_id");
CREATE INDEX "warehouse_machine_plans_machine_id_idx" ON "warehouse_machine_plans"("machine_id");
ALTER TABLE "warehouse_machine_plans" ADD CONSTRAINT "warehouse_machine_plans_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_machine_plans" ADD CONSTRAINT "warehouse_machine_plans_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "warehouse_machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_machine_plans" ADD CONSTRAINT "warehouse_machine_plans_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "maintenance_schedule_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON warehouse_machine_plans TO fleetos_app;
ALTER TABLE warehouse_machine_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_machine_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_machine_plans
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
