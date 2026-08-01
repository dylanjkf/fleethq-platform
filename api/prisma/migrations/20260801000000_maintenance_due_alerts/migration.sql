-- Maintenance-due alert sweep support.
-- Two idempotency marks so the daily sweep raises each plan's "due soon" /
-- "overdue" alert exactly once per service cycle, not every tick. Mirrors the
-- compliance-expiry alert marks on compliance_documents.
ALTER TABLE "asset_maintenance_plans" ADD COLUMN "due_alerted_at" TIMESTAMP(3);
ALTER TABLE "asset_maintenance_plans" ADD COLUMN "overdue_alerted_at" TIMESTAMP(3);

-- The sweep scans live (non-archived) plans per company; this partial index
-- covers exactly that so it never scans archived history.
CREATE INDEX IF NOT EXISTS "asset_maintenance_plans_active_idx"
  ON "asset_maintenance_plans" ("company_id")
  WHERE "archived_at" IS NULL;

-- app role already holds SELECT/INSERT/UPDATE on asset_maintenance_plans (the
-- sweep only reads + updates the two new columns); no new grant needed.
