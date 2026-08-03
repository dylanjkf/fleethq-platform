-- Cross-tenant admin browse indexes (Round 3 audit, Medium).
--
-- The Internal Ops Console lists checklist submissions and maintenance jobs
-- across ALL tenants, ordered by submitted_at / created_at with NO company_id
-- filter. Every existing index on these tables is company_id-leading, so that
-- "browse everything, newest first" query could not use one and fell back to a
-- sequential scan that grows unbounded with tenant count. These bare
-- single-column indexes serve the cross-tenant ORDER BY directly.
--
-- CREATE INDEX CONCURRENTLY can't run inside a transaction; Prisma wraps each
-- migration in one, so these are plain CREATE INDEX. On an empty/new database
-- (the only place migrate deploy runs here) that's instantaneous; on a large
-- existing table, create these manually with CONCURRENTLY instead.
CREATE INDEX IF NOT EXISTS "checklist_submissions_submitted_at_idx" ON "checklist_submissions" ("submitted_at");
CREATE INDEX IF NOT EXISTS "maintenance_jobs_created_at_idx" ON "maintenance_jobs" ("created_at");
