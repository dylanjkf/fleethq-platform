-- Configurable barcode scanning (01-Product/Barcode_Scanning.md) and the
-- Integration Hub foundation (10-Integrations/Integration_Hub.md): a
-- plugin-shaped framework for connecting to external systems, with CSV,
-- generic REST, and generic webhook as the shipped reference connectors.

-- CreateEnum
CREATE TYPE "BarcodeScanMode" AS ENUM ('DATABASE_LOOKUP', 'ENCODED_BARCODE', 'HYBRID');
CREATE TYPE "BarcodeFieldTarget" AS ENUM ('TRACKING_NUMBER', 'CONSIGNMENT_NUMBER', 'MANIFEST_NUMBER', 'INTERNAL_ID', 'CUSTOMER_REFERENCE', 'CUSTOMER', 'DELIVERY_ADDRESS', 'CONTACT', 'DELIVERY_NOTES', 'SERVICE_TYPE', 'PARCEL_COUNT', 'WEIGHT', 'CUBIC', 'DANGEROUS_GOODS', 'CUSTOM_FIELD');
CREATE TYPE "BarcodeScanOutcome" AS ENUM ('MATCHED', 'DUPLICATE_BLOCKED', 'UNKNOWN', 'MISSING_FIELDS', 'IGNORED');
CREATE TYPE "IntegrationConnectorType" AS ENUM ('CSV', 'REST', 'WEBHOOK');
CREATE TYPE "IntegrationDirection" AS ENUM ('IMPORT', 'EXPORT', 'BIDIRECTIONAL');
CREATE TYPE "IntegrationSyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED');
CREATE TYPE "IntegrationSyncStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL_FAILURE', 'FAILURE');
CREATE TYPE "IntegrationTransform" AS ENUM ('NONE', 'UPPERCASE', 'LOWERCASE', 'TRIM', 'DATE_FORMAT', 'UNIT_CONVERSION', 'DEFAULT_VALUE', 'LOOKUP_TABLE');
CREATE TYPE "IntegrationAuthType" AS ENUM ('NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC_AUTH', 'WEBHOOK_SECRET');
CREATE TYPE "IntegrationWebhookDirection" AS ENUM ('INCOMING', 'OUTGOING');
CREATE TYPE "IntegrationDeadLetterStatus" AS ENUM ('PENDING_RETRY', 'RETRYING', 'RESOLVED', 'DEAD');

-- AlterTable: StopParcel gets the richer, all-optional field set a
-- configurable scan can populate. Existing rows (bare `reference`) are
-- unaffected — every new column is nullable.
ALTER TABLE "stop_parcels"
  ADD COLUMN "tracking_number" TEXT,
  ADD COLUMN "consignment_number" TEXT,
  ADD COLUMN "manifest_number" TEXT,
  ADD COLUMN "internal_id" TEXT,
  ADD COLUMN "customer_reference" TEXT,
  ADD COLUMN "delivery_address" TEXT,
  ADD COLUMN "contact_name" TEXT,
  ADD COLUMN "delivery_notes" TEXT,
  ADD COLUMN "service_type" TEXT,
  ADD COLUMN "parcel_count" INTEGER,
  ADD COLUMN "weight_kg" DECIMAL(10,3),
  ADD COLUMN "cubic_m3" DECIMAL(10,3),
  ADD COLUMN "dangerous_goods" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "custom_fields" JSONB;

CREATE INDEX "stop_parcels_company_id_tracking_number_idx" ON "stop_parcels"("company_id", "tracking_number");
CREATE INDEX "stop_parcels_company_id_consignment_number_idx" ON "stop_parcels"("company_id", "consignment_number");
CREATE INDEX "stop_parcels_company_id_manifest_number_idx" ON "stop_parcels"("company_id", "manifest_number");
CREATE INDEX "stop_parcels_company_id_internal_id_idx" ON "stop_parcels"("company_id", "internal_id");
CREATE INDEX "stop_parcels_company_id_customer_reference_idx" ON "stop_parcels"("company_id", "customer_reference");

-- CreateTable
CREATE TABLE "barcode_searchable_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "barcode_searchable_fields_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "barcode_searchable_fields_company_id_key_key" ON "barcode_searchable_fields"("company_id", "key");
CREATE INDEX "barcode_searchable_fields_company_id_idx" ON "barcode_searchable_fields"("company_id");
ALTER TABLE "barcode_searchable_fields" ADD CONSTRAINT "barcode_searchable_fields_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "barcode_field_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "source_field" TEXT NOT NULL,
    "target_field" "BarcodeFieldTarget" NOT NULL,
    "custom_field_key" TEXT,
    "is_database_lookup" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "barcode_field_mappings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "barcode_field_mappings_company_id_idx" ON "barcode_field_mappings"("company_id");
ALTER TABLE "barcode_field_mappings" ADD CONSTRAINT "barcode_field_mappings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "barcode_scan_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "scan_mode" "BarcodeScanMode" NOT NULL DEFAULT 'DATABASE_LOOKUP',
    "allow_manual_entry" BOOLEAN NOT NULL DEFAULT true,
    "block_on_missing_fields" BOOLEAN NOT NULL DEFAULT false,
    "required_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "barcode_scan_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "barcode_scan_configs_company_id_key" ON "barcode_scan_configs"("company_id");
ALTER TABLE "barcode_scan_configs" ADD CONSTRAINT "barcode_scan_configs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "barcode_scan_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID,
    "user_id" UUID,
    "scanned_value" TEXT NOT NULL,
    "scan_mode" "BarcodeScanMode" NOT NULL,
    "outcome" "BarcodeScanOutcome" NOT NULL,
    "matched_parcel_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "barcode_scan_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "barcode_scan_events_company_id_user_id_created_at_idx" ON "barcode_scan_events"("company_id", "user_id", "created_at");
ALTER TABLE "barcode_scan_events" ADD CONSTRAINT "barcode_scan_events_matched_parcel_id_fkey" FOREIGN KEY ("matched_parcel_id") REFERENCES "stop_parcels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "auth_type" "IntegrationAuthType" NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "encryption_iv" TEXT NOT NULL,
    "encryption_tag" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "rotated_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_credentials_company_id_idx" ON "integration_credentials"("company_id");
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "connector_type" "IntegrationConnectorType" NOT NULL,
    "direction" "IntegrationDirection" NOT NULL DEFAULT 'IMPORT',
    "target_entity" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "credential_id" UUID,
    "schedule_cron" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" "IntegrationSyncStatus",
    "next_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_connections_company_id_idx" ON "integration_connections"("company_id");
CREATE INDEX "integration_connections_company_id_is_enabled_next_run_at_idx" ON "integration_connections"("company_id", "is_enabled", "next_run_at");
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "integration_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_field_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_field" TEXT NOT NULL,
    "fleet_field" TEXT NOT NULL,
    "transform" "IntegrationTransform" NOT NULL DEFAULT 'NONE',
    "transform_config" JSONB,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "integration_field_mappings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_field_mappings_company_id_connection_id_idx" ON "integration_field_mappings"("company_id", "connection_id");
ALTER TABLE "integration_field_mappings" ADD CONSTRAINT "integration_field_mappings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_field_mappings" ADD CONSTRAINT "integration_field_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_sync_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "trigger" "IntegrationSyncTrigger" NOT NULL,
    "status" "IntegrationSyncStatus" NOT NULL DEFAULT 'PENDING',
    "triggered_by_user_id" UUID,
    "records_processed" INTEGER NOT NULL DEFAULT 0,
    "records_succeeded" INTEGER NOT NULL DEFAULT 0,
    "records_failed" INTEGER NOT NULL DEFAULT 0,
    "error_summary" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "integration_sync_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_sync_runs_company_id_connection_id_started_at_idx" ON "integration_sync_runs"("company_id", "connection_id", "started_at");
ALTER TABLE "integration_sync_runs" ADD CONSTRAINT "integration_sync_runs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_dead_letters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "sync_run_id" UUID,
    "external_ref" TEXT,
    "raw_payload" JSONB NOT NULL,
    "error_message" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "status" "IntegrationDeadLetterStatus" NOT NULL DEFAULT 'PENDING_RETRY',
    "next_retry_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "integration_dead_letters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_dead_letters_company_id_connection_id_status_idx" ON "integration_dead_letters"("company_id", "connection_id", "status");
ALTER TABLE "integration_dead_letters" ADD CONSTRAINT "integration_dead_letters_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_webhooks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "connection_id" UUID,
    "name" TEXT NOT NULL,
    "direction" "IntegrationWebhookDirection" NOT NULL,
    "target_url" TEXT,
    "inbound_token" TEXT,
    "secret_credential_id" UUID,
    "header_template" JSONB,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    CONSTRAINT "integration_webhooks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "integration_webhooks_inbound_token_key" ON "integration_webhooks"("inbound_token");
CREATE INDEX "integration_webhooks_company_id_idx" ON "integration_webhooks"("company_id");
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_webhooks" ADD CONSTRAINT "integration_webhooks_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "integration_webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "direction" "IntegrationWebhookDirection" NOT NULL,
    "request_payload" JSONB,
    "response_status" INTEGER,
    "success" BOOLEAN NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "integration_webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "integration_webhook_deliveries_webhook_id_created_at_idx" ON "integration_webhook_deliveries"("webhook_id", "created_at");
ALTER TABLE "integration_webhook_deliveries" ADD CONSTRAINT "integration_webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "integration_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: same tenant-isolation pattern as every other table
-- (see 20260726120000_stock_adjustments for the reference shape). Config
-- tables (searchable fields, mappings, scan config, connections, field
-- mappings, credentials, webhooks) get full SELECT/INSERT/UPDATE — they're
-- admin-edited. Append-only logs (scan events, sync runs, webhook
-- deliveries) get SELECT/INSERT only. Dead letters get UPDATE too (retry
-- status transitions).

ALTER TABLE "barcode_searchable_fields" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "barcode_searchable_fields" FORCE ROW LEVEL SECURITY;
CREATE POLICY "barcode_searchable_fields_tenant_isolation" ON "barcode_searchable_fields"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "barcode_searchable_fields" TO fleetos_app;

ALTER TABLE "barcode_field_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "barcode_field_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "barcode_field_mappings_tenant_isolation" ON "barcode_field_mappings"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "barcode_field_mappings" TO fleetos_app;

ALTER TABLE "barcode_scan_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "barcode_scan_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "barcode_scan_configs_tenant_isolation" ON "barcode_scan_configs"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "barcode_scan_configs" TO fleetos_app;

ALTER TABLE "barcode_scan_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "barcode_scan_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "barcode_scan_events_tenant_isolation" ON "barcode_scan_events"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT ON "barcode_scan_events" TO fleetos_app;

ALTER TABLE "integration_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_credentials" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_credentials_tenant_isolation" ON "integration_credentials"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "integration_credentials" TO fleetos_app;

ALTER TABLE "integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_connections_tenant_isolation" ON "integration_connections"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "integration_connections" TO fleetos_app;

ALTER TABLE "integration_field_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_field_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_field_mappings_tenant_isolation" ON "integration_field_mappings"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "integration_field_mappings" TO fleetos_app;

ALTER TABLE "integration_sync_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_sync_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_sync_runs_tenant_isolation" ON "integration_sync_runs"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "integration_sync_runs" TO fleetos_app;

ALTER TABLE "integration_dead_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_dead_letters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_dead_letters_tenant_isolation" ON "integration_dead_letters"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "integration_dead_letters" TO fleetos_app;

ALTER TABLE "integration_webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_webhooks_tenant_isolation" ON "integration_webhooks"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON "integration_webhooks" TO fleetos_app;

ALTER TABLE "integration_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integration_webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "integration_webhook_deliveries_tenant_isolation" ON "integration_webhook_deliveries"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
GRANT SELECT, INSERT ON "integration_webhook_deliveries" TO fleetos_app;
