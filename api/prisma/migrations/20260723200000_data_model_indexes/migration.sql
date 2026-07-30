-- Additive data-model hardening: foreign-key composite indexes, plus a set of
-- partial-unique / partial indexes that Prisma's schema DSL can't express
-- (filtered indexes). All CREATE-only, no table rewrites, no data change.

-- 1. Foreign-key composite indexes leading with company_id.
--    Every tenant-scoped query already filters by company_id (RLS + service
--    layer), then joins/filters by asset or operator. Without these, "all
--    maintenance for this asset" / "all compliance docs for this operator" /
--    "all jobs for this operator" fall back to the single-column company_id
--    index and post-filter in memory — fine at 10 assets, a table scan at
--    10,000. These match the access patterns the services actually issue.
CREATE INDEX IF NOT EXISTS "maintenance_jobs_company_id_asset_id_idx" ON "maintenance_jobs" ("company_id", "asset_id");
CREATE INDEX IF NOT EXISTS "compliance_documents_company_id_asset_id_idx" ON "compliance_documents" ("company_id", "asset_id");
CREATE INDEX IF NOT EXISTS "compliance_documents_company_id_operator_id_idx" ON "compliance_documents" ("company_id", "operator_id");
CREATE INDEX IF NOT EXISTS "jobs_company_id_operator_id_idx" ON "jobs" ("company_id", "operator_id");
CREATE INDEX IF NOT EXISTS "jobs_company_id_asset_id_idx" ON "jobs" ("company_id", "asset_id");

-- 2. One active shift per operator — a race-safe backstop.
--    ShiftsService already checks for an existing ACTIVE shift before starting
--    one, but a check-then-insert has a concurrency window (two "start shift"
--    taps that both pass the check). This partial unique index closes it at the
--    database: at most one row per operator can have status = 'ACTIVE' at a
--    time. ENDED shifts don't count, so an operator can start a new shift after
--    ending the previous one.
CREATE UNIQUE INDEX IF NOT EXISTS "operator_one_active_shift" ON "operator_shifts" ("operator_id") WHERE "status" = 'ACTIVE';

-- 3. Asset VIN / registration uniqueness within a company (data quality).
--    Prevents the same vehicle being entered twice — a real courier data-entry
--    hazard. Scoped per company and to live (non-archived) assets only, so a
--    decommissioned asset's plate can be reused by a replacement, and NULLs are
--    excluded (VIN/registration are optional fields).
CREATE UNIQUE INDEX IF NOT EXISTS "assets_company_id_vin_active_key" ON "assets" ("company_id", "vin") WHERE "vin" IS NOT NULL AND "archived_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "assets_company_id_registration_active_key" ON "assets" ("company_id", "registration") WHERE "registration" IS NOT NULL AND "archived_at" IS NULL;

-- 4. Notification digest sweep.
--    computeDigest() scans notifications WHERE emailed_at IS NULL AND
--    read_at IS NULL ORDER BY created_at. This partial index covers exactly the
--    un-emailed, unread slice — which shrinks to near-empty steady-state — so
--    the daily digest never scans the full (ever-growing) notifications table.
CREATE INDEX IF NOT EXISTS "notifications_pending_digest_idx" ON "notifications" ("company_id", "created_at") WHERE "emailed_at" IS NULL AND "read_at" IS NULL;
