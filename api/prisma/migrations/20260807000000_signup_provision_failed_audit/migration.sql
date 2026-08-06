-- Add SIGNUP_PROVISION_FAILED to the billing audit event enum. This is the
-- staff-actionable alert raised by the signup reconciliation sweep when a paid
-- Checkout Session could not be turned into a company + admin after retries
-- (the customer was charged but has no account yet).
--
-- Safe as a standalone ALTER TYPE ... ADD VALUE: PostgreSQL 12+ allows adding
-- an enum value outside a transaction block, and this migration does not use
-- the new value in the same migration.
ALTER TYPE "BillingAuditEventType" ADD VALUE 'SIGNUP_PROVISION_FAILED';
