-- Idempotency ledger for Stripe webhook delivery (audit remediation: billing).
-- Stripe can deliver a webhook more than once and out of order; this table lets
-- the handler skip a duplicate event, and companies.last_stripe_event_at guards
-- against a stale subscription event reverting newer state.

CREATE TABLE "stripe_webhook_events" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

-- Written only via the privileged fleetos_auth role (SystemPrismaService), the
-- same path used for scheduler_leases / audit_logs. No RLS: not tenant data.
GRANT SELECT, INSERT ON "stripe_webhook_events" TO fleetos_auth;

-- Ordering guard for out-of-order subscription events.
ALTER TABLE "companies" ADD COLUMN "last_stripe_event_at" TIMESTAMP(3);
