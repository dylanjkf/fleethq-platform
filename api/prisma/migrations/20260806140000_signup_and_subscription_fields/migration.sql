-- Self-serve signup + per-asset subscription depth (19-Billing/Per_Asset_Billing.md,
-- Self_Serve_Signup.md). Adds the pending-signup staging table (payment-first
-- provisioning), the Stripe subscription-item id + current-period fields on
-- companies, nullable company on the audit log (pre-provisioning signup events),
-- and the new audit event types.

-- AlterEnum: new billing audit event types (safe to add in-tx on PG12+ as long
-- as the new values are not used within this same migration, which they aren't).
ALTER TYPE "BillingAuditEventType" ADD VALUE 'SIGNUP_STARTED';
ALTER TYPE "BillingAuditEventType" ADD VALUE 'SIGNUP_COMPLETED';
ALTER TYPE "BillingAuditEventType" ADD VALUE 'SIGNUP_EXPIRED';
ALTER TYPE "BillingAuditEventType" ADD VALUE 'PAYMENT_FAILED';
ALTER TYPE "BillingAuditEventType" ADD VALUE 'SUBSCRIPTION_CANCELED';

-- CreateEnum
CREATE TYPE "PendingSignupStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED');

-- AlterTable: Stripe subscription-item id + current billing period on companies
ALTER TABLE "companies" ADD COLUMN "stripe_subscription_item_id" TEXT;
ALTER TABLE "companies" ADD COLUMN "current_period_start" TIMESTAMP(3);
ALTER TABLE "companies" ADD COLUMN "current_period_end" TIMESTAMP(3);

-- AlterTable: billing_audit_logs.company_id becomes nullable (pre-provisioning
-- signup events have no company yet).
ALTER TABLE "billing_audit_logs" ALTER COLUMN "company_id" DROP NOT NULL;

-- CreateTable: pending signups (payment-first provisioning staging)
CREATE TABLE "pending_signups" (
    "id" UUID NOT NULL,
    "stripe_checkout_session_id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "admin_email" TEXT NOT NULL,
    "admin_name" TEXT NOT NULL,
    "requested_quantity" INTEGER NOT NULL,
    "hashed_password" TEXT,
    "status" "PendingSignupStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_signups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_signups_stripe_checkout_session_id_key" ON "pending_signups"("stripe_checkout_session_id");

-- CreateIndex
CREATE INDEX "pending_signups_status_expires_at_idx" ON "pending_signups"("status", "expires_at");

-- ---------------------------------------------------------------------------
-- Grants. pending_signups is pre-tenant staging data (no company_id, no RLS):
-- it is written and read ONLY via the privileged fleetos_auth role
-- (SystemPrismaService) — the public signup endpoint and the provisioning
-- webhook both go through it, so the bcrypt-hashed password is never reachable
-- from the tenant runtime role (fleetos_app). DELETE is for the expiry job.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_signups" TO fleetos_auth;
