-- Checklist/inspection bundles (deploy a group of checklist templates to an
-- asset class) and portable depot/customer address books.

CREATE TABLE "checklist_bundles" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "checklist_bundles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "checklist_bundles_company_id_idx" ON "checklist_bundles"("company_id");
ALTER TABLE "checklist_bundles" ADD CONSTRAINT "checklist_bundles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "checklist_bundle_items" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_bundle_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "checklist_bundle_items_bundle_id_template_id_key" ON "checklist_bundle_items"("bundle_id", "template_id");
CREATE INDEX "checklist_bundle_items_company_id_idx" ON "checklist_bundle_items"("company_id");
ALTER TABLE "checklist_bundle_items" ADD CONSTRAINT "checklist_bundle_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checklist_bundle_items" ADD CONSTRAINT "checklist_bundle_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "checklist_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checklist_bundle_items" ADD CONSTRAINT "checklist_bundle_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "address_books" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entries" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "address_books_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "address_books_company_id_idx" ON "address_books"("company_id");
ALTER TABLE "address_books" ADD CONSTRAINT "address_books_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: tenant-scoped, mutable (no DELETE — archive/cascade). Bundle items get
-- DELETE too (a bundle can drop a template; the row is a pure join).
GRANT SELECT, INSERT, UPDATE ON checklist_bundles TO fleetos_app;
ALTER TABLE checklist_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checklist_bundles
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON checklist_bundle_items TO fleetos_app;
ALTER TABLE checklist_bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_bundle_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checklist_bundle_items
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON address_books TO fleetos_app;
ALTER TABLE address_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE address_books FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON address_books
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
