-- Customer-saved fatigue rule sets: a "savable layout" deployable to many
-- operators (or set as the company default).
CREATE TABLE "fatigue_rule_sets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "max_work_24h_min" INTEGER NOT NULL,
    "min_rest_24h_min" INTEGER NOT NULL,
    "max_work_7d_min" INTEGER NOT NULL,
    "min_rest_7d_min" INTEGER NOT NULL,
    "approaching_buffer_min" INTEGER NOT NULL,
    "lookback_days" INTEGER NOT NULL DEFAULT 8,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "fatigue_rule_sets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fatigue_rule_sets_company_id_idx" ON "fatigue_rule_sets"("company_id");
ALTER TABLE "fatigue_rule_sets" ADD CONSTRAINT "fatigue_rule_sets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operators" ADD COLUMN "fatigue_rule_set_id" UUID;
ALTER TABLE "operators" ADD CONSTRAINT "operators_fatigue_rule_set_id_fkey" FOREIGN KEY ("fatigue_rule_set_id") REFERENCES "fatigue_rule_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: tenant-scoped, mutable (no DELETE — archive instead).
GRANT SELECT, INSERT, UPDATE ON fatigue_rule_sets TO fleetos_app;
ALTER TABLE fatigue_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fatigue_rule_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fatigue_rule_sets
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
