-- Per-asset billing (19-Billing/Per_Asset_Billing.md): a single $19 AUD/asset/
-- month price whose purchased quantity is the hard cap on live assets. Adds the
-- per-company purchased quantity, a single-row settings table (one source of
-- truth for the price), a local Stripe-invoice cache, and an append-only
-- billing audit log (incl. cap-block attempts).

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "BillingAuditEventType" AS ENUM ('CAP_BLOCKED', 'QUANTITY_CHANGED', 'SUBSCRIPTION_SYNCED', 'WEBHOOK_RECEIVED', 'MANUAL_OVERRIDE');

-- AlterTable: the per-company purchased asset quantity (source of truth for the cap)
ALTER TABLE "companies" ADD COLUMN "asset_quantity" INTEGER;

-- CreateTable: single-row global billing config (id is pinned to 1)
CREATE TABLE "billing_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "price_per_asset_cents" INTEGER NOT NULL DEFAULT 1900,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "billing_interval" TEXT NOT NULL DEFAULT 'month',
    "gst_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "abn" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_settings_singleton" CHECK ("id" = 1)
);

-- Seed the one settings row with the launch defaults ($19.00 AUD / asset / month,
-- 10% GST). Idempotent so a re-run (or a later migrate on a DB that already has
-- it) is a no-op.
INSERT INTO "billing_settings" ("id", "price_per_asset_cents", "currency", "billing_interval", "gst_rate", "updated_at")
VALUES (1, 1900, 'AUD', 'month', 0.10, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- CreateTable: local cache of Stripe invoices (Stripe stays source of truth)
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "number" TEXT,
    "status" "InvoiceStatus" NOT NULL,
    "amount_due_cents" INTEGER NOT NULL,
    "amount_paid_cents" INTEGER NOT NULL DEFAULT 0,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "hosted_invoice_url" TEXT,
    "invoice_pdf_url" TEXT,
    "issued_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "invoices_company_id_idx" ON "invoices"("company_id");

-- CreateTable: append-only billing audit log (incl. cap-block attempts)
CREATE TABLE "billing_audit_logs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "event_type" "BillingAuditEventType" NOT NULL,
    "actor_user_id" UUID,
    "actor_admin_id" UUID,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_audit_logs_company_id_created_at_idx" ON "billing_audit_logs"("company_id", "created_at");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_audit_logs" ADD CONSTRAINT "billing_audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Grants + row-level security (hand-written, per prisma/migrations/*_add_row_level_security).
-- ---------------------------------------------------------------------------

-- billing_settings: global platform config, NOT tenant data, so no RLS.
--   fleetos_app reads it (customer billing page shows the $/asset price);
--   fleetos_auth reads it (billing service on the system connection);
--   fleetos_admin reads + updates it (admin billing settings, editable later).
GRANT SELECT ON "billing_settings" TO fleetos_app;
GRANT SELECT ON "billing_settings" TO fleetos_auth;
GRANT SELECT, UPDATE ON "billing_settings" TO fleetos_admin;

-- invoices: tenant data. Customer reads only its own (RLS); the webhook writer
-- (fleetos_auth, BYPASSRLS) upserts them; the admin console (fleetos_admin,
-- BYPASSRLS) reads across tenants.
GRANT SELECT ON "invoices" TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON "invoices" TO fleetos_auth;
GRANT SELECT ON "invoices" TO fleetos_admin;

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invoices"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- billing_audit_logs: tenant data, append-only. Customer reads its own (RLS).
-- Writes come from the privileged roles only: fleetos_auth writes CAP_BLOCKED
-- (on a separate connection, so the write survives the rollback of the tenant
-- transaction whose create was rejected) and webhook events; fleetos_admin
-- writes manual overrides and reads across tenants. fleetos_app never writes.
GRANT SELECT ON "billing_audit_logs" TO fleetos_app;
GRANT SELECT, INSERT ON "billing_audit_logs" TO fleetos_auth;
GRANT SELECT, INSERT ON "billing_audit_logs" TO fleetos_admin;

ALTER TABLE "billing_audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "billing_audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "billing_audit_logs"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
