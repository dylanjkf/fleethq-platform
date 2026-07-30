-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TimelineEntityType" ADD VALUE 'CHECKLIST_TEMPLATE';
ALTER TYPE "TimelineEntityType" ADD VALUE 'CHECKLIST_SUBMISSION';

-- CreateTable
CREATE TABLE "checklist_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "applies_to_asset_class_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "checklist_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_submissions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "template_snapshot" JSONB NOT NULL,
    "asset_id" UUID NOT NULL,
    "operator_id" UUID,
    "answers" JSONB NOT NULL,
    "has_failures" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checklist_templates_company_id_idx" ON "checklist_templates"("company_id");

-- CreateIndex
CREATE INDEX "checklist_submissions_company_id_idx" ON "checklist_submissions"("company_id");

-- CreateIndex
CREATE INDEX "checklist_submissions_company_id_asset_id_idx" ON "checklist_submissions"("company_id", "asset_id");

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_applies_to_asset_class_id_fkey" FOREIGN KEY ("applies_to_asset_class_id") REFERENCES "asset_classes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_submissions" ADD CONSTRAINT "checklist_submissions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (hand-written, per prisma/migrations/*_add_row_level_security).
-- Templates are office-editable, so the app role may SELECT/INSERT/UPDATE (never
-- DELETE — no hard deletes; archiving sets archived_at). Submissions are
-- append-only and immutable once written, so the app role gets only SELECT +
-- INSERT — the same structural immutability the timeline_events table relies on.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON checklist_templates TO fleetos_app;

ALTER TABLE checklist_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checklist_templates
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT ON checklist_submissions TO fleetos_app;

ALTER TABLE checklist_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checklist_submissions
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
