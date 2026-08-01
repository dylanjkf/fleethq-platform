-- Customer / Depot natural-key de-duplication (data quality).
--    Re-importing the same customers/depots (CSV bulk import or a scheduled
--    Integration Sync) currently inserts a second row with the same name — the
--    import path had no natural-key guard, so a directory re-import silently
--    duplicated every entry. These partial-unique indexes make a company's live
--    (non-archived) customers and depots unique by case-insensitive name, so a
--    re-import — or two concurrent creates racing the same name — resolves to
--    the existing row instead of duplicating it.
--
--    Mirrors the asset VIN / registration filtered indexes in migration
--    20260723200000: expression + filtered indexes that Prisma's schema DSL
--    can't express, so they live only in this migration SQL (documented with a
--    comment on the Customer / Depot models). lower(name) makes "ACME" and
--    "acme" the same key; archived rows are excluded so a retired customer's or
--    depot's name can be reused by a live replacement.
CREATE UNIQUE INDEX IF NOT EXISTS "customers_company_id_name_active_key" ON "customers" ("company_id", lower("name")) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "depots_company_id_name_active_key" ON "depots" ("company_id", lower("name")) WHERE "archived_at" IS NULL;
