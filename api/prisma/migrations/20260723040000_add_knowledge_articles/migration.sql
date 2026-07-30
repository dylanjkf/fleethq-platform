-- Internal knowledge base: authored articles / SOPs (markdown body).
CREATE TABLE "knowledge_articles" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "author_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "knowledge_articles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_articles_company_id_category_idx" ON "knowledge_articles"("company_id", "category");

ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "knowledge_articles" ADD CONSTRAINT "knowledge_articles_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: tenant-scoped, mutable (edit/publish/archive). App role gets
-- SELECT/INSERT/UPDATE — no DELETE (no hard deletes; archive instead).
GRANT SELECT, INSERT, UPDATE ON knowledge_articles TO fleetos_app;
ALTER TABLE knowledge_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_articles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_articles
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
