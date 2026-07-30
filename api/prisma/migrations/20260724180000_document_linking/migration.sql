-- Let Knowledge Base articles and Form templates reference a Document, so a
-- policy/SOP/guidance PDF that already lives in the document library can be
-- surfaced where it's actually used instead of being uploaded a second time.
--
-- Deliberately a reference to `documents`, not a second `file_attachment_id` on
-- each table: the file, its title, its category and its archive state already
-- have exactly one home. Pointing at it keeps one upload path, one download
-- path and one storage switch (Postgres inline vs S3), and honours the
-- zero-duplicate-data-entry rule — the same PDF can be a document, the body of
-- a knowledge article, and a form's reference material without being stored
-- three times.
--
-- ON DELETE RESTRICT is implicit (the default): documents are archived, never
-- hard-deleted, so a linked document cannot silently vanish from under an
-- article. Both columns are nullable, so every existing row is unaffected.

ALTER TABLE "knowledge_articles" ADD COLUMN "source_document_id" UUID;

ALTER TABLE "knowledge_articles"
  ADD CONSTRAINT "knowledge_articles_source_document_id_fkey"
  FOREIGN KEY ("source_document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reverse lookup: "which articles reference this document?" — asked whenever a
-- document is archived, and by the article list's include.
CREATE INDEX "knowledge_articles_source_document_id_idx" ON "knowledge_articles"("source_document_id");

-- An article is now either authored markdown, an imported document, or both, so
-- a body is no longer mandatory. Widening a NOT NULL column is safe for every
-- existing row.
ALTER TABLE "knowledge_articles" ALTER COLUMN "body" DROP NOT NULL;

ALTER TABLE "form_templates" ADD COLUMN "reference_document_id" UUID;

ALTER TABLE "form_templates"
  ADD CONSTRAINT "form_templates_reference_document_id_fkey"
  FOREIGN KEY ("reference_document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "form_templates_reference_document_id_idx" ON "form_templates"("reference_document_id");
