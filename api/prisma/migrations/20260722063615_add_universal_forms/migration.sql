-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TimelineEntityType" ADD VALUE 'FORM_TEMPLATE';
ALTER TYPE "TimelineEntityType" ADD VALUE 'FORM_SUBMISSION';

-- CreateEnum
CREATE TYPE "FormTargetContext" AS ENUM ('DRIVER', 'OFFICE', 'BOTH');

-- CreateTable
CREATE TABLE "form_templates" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "target_context" "FormTargetContext" NOT NULL DEFAULT 'BOTH',
    "version" INTEGER NOT NULL DEFAULT 1,
    "fields" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "template_snapshot" JSONB NOT NULL,
    "answers" JSONB NOT NULL,
    "submitted_by_user_id" UUID,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "form_templates_company_id_idx" ON "form_templates"("company_id");

-- CreateIndex
CREATE INDEX "form_submissions_company_id_idx" ON "form_submissions"("company_id");

-- AddForeignKey
ALTER TABLE "form_templates" ADD CONSTRAINT "form_templates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "form_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security (hand-written, per prisma/migrations/*_add_row_level_security).
-- Same shape as checklist_templates/checklist_submissions: templates are
-- office-editable (SELECT/INSERT/UPDATE, never DELETE — archiving sets
-- archived_at), submissions are append-only and immutable (SELECT/INSERT only).
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON form_templates TO fleetos_app;

ALTER TABLE form_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON form_templates
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT ON form_submissions TO fleetos_app;

ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON form_submissions
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
