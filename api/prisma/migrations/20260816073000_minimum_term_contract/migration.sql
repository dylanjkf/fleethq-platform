-- Minimum-term contract (Part 2, 19-Billing).
--
-- subscription_started_at : set once, when the subscription first becomes live
--                           (trialing/active). Basis for the term.
-- contract_ends_at        : subscription_started_at + 12 months — the date before
--                           which the customer cannot self-cancel.
-- contract_released_at /   : the `cancel_for_cause` escape hatch — staff-only,
-- contract_release_reason   audited. Non-null lifts the lock-in early.
--
-- LEGAL: the 12-month, no-self-serve-cancel term this supports needs legal
-- sign-off before enforcement is enabled in production (env
-- BILLING_CONTRACT_ENFORCED, off by default) — ACL unfair-contract-term risk.

ALTER TABLE "companies"
  ADD COLUMN "subscription_started_at" TIMESTAMP(3),
  ADD COLUMN "contract_ends_at"        TIMESTAMP(3),
  ADD COLUMN "contract_released_at"    TIMESTAMP(3),
  ADD COLUMN "contract_release_reason" TEXT;
