-- Warehouse add-on: stock inventory + warehouse machines with
-- maintenance/monitoring logs. Data entry is NEVER billing-gated at the DB or
-- API layer — the add-on flag only drives UI presentation.

CREATE TABLE "stock_items" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "location" TEXT,
    "min_quantity" DOUBLE PRECISION,
    "attributes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stock_items_company_id_category_idx" ON "stock_items"("company_id", "category");
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "warehouse_machines" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "machine_type" TEXT,
    "serial_number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPERATIONAL',
    "location" TEXT,
    "notes" TEXT,
    "attributes" JSONB,
    "last_service_at" TIMESTAMP(3),
    "next_service_due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "warehouse_machines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warehouse_machines_company_id_idx" ON "warehouse_machines"("company_id");
ALTER TABLE "warehouse_machines" ADD CONSTRAINT "warehouse_machines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "warehouse_machine_logs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "machine_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "meter_value" DOUBLE PRECISION,
    "meter_unit" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_machine_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warehouse_machine_logs_company_id_idx" ON "warehouse_machine_logs"("company_id");
CREATE INDEX "warehouse_machine_logs_machine_id_idx" ON "warehouse_machine_logs"("machine_id");
ALTER TABLE "warehouse_machine_logs" ADD CONSTRAINT "warehouse_machine_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_machine_logs" ADD CONSTRAINT "warehouse_machine_logs_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "warehouse_machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "warehouse_machine_logs" ADD CONSTRAINT "warehouse_machine_logs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: tenant-scoped. Stock/machines are mutable (SELECT/INSERT/UPDATE, no
-- DELETE — archive instead); machine logs are append-only (no UPDATE either).
GRANT SELECT, INSERT, UPDATE ON stock_items TO fleetos_app;
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_items
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON warehouse_machines TO fleetos_app;
ALTER TABLE warehouse_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_machines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_machines
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT ON warehouse_machine_logs TO fleetos_app;
ALTER TABLE warehouse_machine_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_machine_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_machine_logs
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
