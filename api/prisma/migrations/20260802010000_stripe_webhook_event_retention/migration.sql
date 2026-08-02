-- Retention for the Stripe webhook idempotency ledger (audit remediation:
-- billing). The `stripe_webhook_events` table (migration 20260731110000) is an
-- append-only idempotency ledger that otherwise grows unbounded — RetentionService
-- now purges rows past a bounded window (default 90 days, STRIPE_WEBHOOK_EVENT_RETENTION_DAYS).
--
-- The ledger is written only via the privileged fleetos_auth role
-- (SystemPrismaService), which today holds SELECT, INSERT. The retention purge
-- runs on that same role/path, so grant it DELETE as well — no new role, no RLS
-- (this is a global, non-tenant table).
GRANT DELETE ON "stripe_webhook_events" TO fleetos_auth;
