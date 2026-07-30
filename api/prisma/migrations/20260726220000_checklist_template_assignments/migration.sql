-- Persistent "this inspection applies to this specific asset" links, so the
-- office assigns a checklist template to an asset once instead of re-selecting
-- it every day. Complements the existing class-level targeting on
-- checklist_templates.applies_to_asset_class_id.

-- CreateTable
CREATE TABLE "checklist_template_assignments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_template_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checklist_template_assignments_template_id_asset_id_key" ON "checklist_template_assignments"("template_id", "asset_id");
CREATE INDEX "checklist_template_assignments_company_id_idx" ON "checklist_template_assignments"("company_id");
CREATE INDEX "checklist_template_assignments_company_id_asset_id_idx" ON "checklist_template_assignments"("company_id", "asset_id");

-- AddForeignKey
ALTER TABLE "checklist_template_assignments" ADD CONSTRAINT "checklist_template_assignments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checklist_template_assignments" ADD CONSTRAINT "checklist_template_assignments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checklist_template_assignments" ADD CONSTRAINT "checklist_template_assignments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: the runtime app role sees/writes only its own tenant's
-- rows. Assignments are added and removed (never updated), so grant DELETE too,
-- mirroring checklist_bundle_items.
GRANT SELECT, INSERT, DELETE ON checklist_template_assignments TO fleetos_app;
ALTER TABLE checklist_template_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_template_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checklist_template_assignments
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
