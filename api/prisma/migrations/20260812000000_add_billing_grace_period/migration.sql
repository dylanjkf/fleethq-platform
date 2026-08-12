-- Non-payment grace window (item 7). Set on the first failed payment of a dunning
-- cycle to now + 5 business days (weekends excluded, holidays not considered); the
-- account stays fully active until this instant, after which the existing billing
-- read-only restriction applies. Cleared on recovery (invoice.paid).
ALTER TABLE "companies" ADD COLUMN "grace_period_ends_at" TIMESTAMP(3);
