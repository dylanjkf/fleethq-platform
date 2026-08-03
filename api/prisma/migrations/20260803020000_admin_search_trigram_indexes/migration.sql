-- Global admin search (AdminSearchService) runs case-insensitive `contains`
-- queries, i.e. ILIKE '%q%' with a LEADING wildcard, over:
--   companies.name
--   users.full_name / users.email / users.username
--   assets.name / assets.registration / assets.vin
-- A B-tree index cannot serve a leading-wildcard ILIKE, so every keystroke in the
-- ⌘K palette was a sequential scan of the whole table. pg_trgm GIN indexes make
-- these ILIKE probes index-backed, keeping cross-tenant search fast as the row
-- counts grow.
--
-- Notes:
--  * gin_trgm_ops accelerates ILIKE / LIKE (and =) directly — no lower() needed.
--  * Not CONCURRENTLY: Prisma wraps each migration in a transaction, and
--    CREATE INDEX CONCURRENTLY cannot run inside one. These tables are modest and
--    the brief lock is acceptable at migration time.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "companies_name_trgm_idx"
  ON "companies" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "users_full_name_trgm_idx"
  ON "users" USING gin ("full_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_email_trgm_idx"
  ON "users" USING gin ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_username_trgm_idx"
  ON "users" USING gin ("username" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "assets_name_trgm_idx"
  ON "assets" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "assets_registration_trgm_idx"
  ON "assets" USING gin ("registration" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "assets_vin_trgm_idx"
  ON "assets" USING gin ("vin" gin_trgm_ops);
