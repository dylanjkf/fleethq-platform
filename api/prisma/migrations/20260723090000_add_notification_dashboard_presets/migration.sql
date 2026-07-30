-- Notification preset bundles + dashboard layout presets (Saved Layouts),
-- plus a per-member saved dashboard arrangement.

ALTER TABLE "company_memberships" ADD COLUMN "dashboard_layout" JSONB;

CREATE TABLE "notification_presets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "digest_only" BOOLEAN NOT NULL DEFAULT false,
    "muted_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "notification_presets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_presets_company_id_idx" ON "notification_presets"("company_id");
ALTER TABLE "notification_presets" ADD CONSTRAINT "notification_presets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "dashboard_layout_presets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "widgets" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "dashboard_layout_presets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "dashboard_layout_presets_company_id_idx" ON "dashboard_layout_presets"("company_id");
ALTER TABLE "dashboard_layout_presets" ADD CONSTRAINT "dashboard_layout_presets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE ON notification_presets TO fleetos_app;
ALTER TABLE notification_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_presets
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON dashboard_layout_presets TO fleetos_app;
ALTER TABLE dashboard_layout_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_layout_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dashboard_layout_presets
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
