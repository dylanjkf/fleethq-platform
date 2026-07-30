-- Compliance-expiry alert sweep support.
-- Two idempotency marks so the daily sweep raises each document's "expiring
-- soon" / "expired" alert exactly once, not every tick.
ALTER TABLE "compliance_documents" ADD COLUMN "expiring_alerted_at" TIMESTAMP(3);
ALTER TABLE "compliance_documents" ADD COLUMN "expired_alerted_at" TIMESTAMP(3);

-- The sweep scans live documents by expiry date; this partial index covers
-- exactly that (non-archived rows, ordered by expires_at) so it never scans
-- archived history.
CREATE INDEX IF NOT EXISTS "compliance_documents_active_expiry_idx"
  ON "compliance_documents" ("company_id", "expires_at")
  WHERE "archived_at" IS NULL;

-- app role already holds SELECT/INSERT/UPDATE on compliance_documents (the
-- sweep only reads + updates the two new columns); no new grant needed.
