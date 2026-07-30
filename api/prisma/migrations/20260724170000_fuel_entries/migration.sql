-- Fuel card purchases: what a driver put into a vehicle, captured in DriverOS
-- and tracked in FleetHQ.
--
-- `card_last4` is deliberately the ONLY card data stored, and is constrained to
-- exactly four digits. Under PCI DSS the last four digits are not sensitive
-- authentication data and may be stored, but a full PAN must never be — the
-- CHECK constraint makes pasting a whole card number a database-level failure
-- rather than something that quietly persists.
--
-- `licence_plate` is captured as free text even though Asset now has a
-- `registration` column: fuel cards get used across vehicles and the plate
-- printed on the receipt is the ground truth for reconciling a statement. The
-- optional `asset_id` link is the fleet's interpretation of that plate.

CREATE TABLE "fuel_entries" (
  "id"                    UUID         NOT NULL DEFAULT gen_random_uuid(),
  "company_id"            UUID         NOT NULL,
  "asset_id"              UUID,
  "operator_id"           UUID,
  "receipt_attachment_id" UUID,
  "odometer_reading"      INTEGER      NOT NULL,
  "licence_plate"         TEXT         NOT NULL,
  "card_last4"            TEXT         NOT NULL,
  "litres"                NUMERIC(10, 2),
  "total_cost"            NUMERIC(10, 2),
  "filled_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"                 TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fuel_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_entries_card_last4_check" CHECK ("card_last4" ~ '^[0-9]{4}$'),
  CONSTRAINT "fuel_entries_odometer_check" CHECK ("odometer_reading" >= 0),
  CONSTRAINT "fuel_entries_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fuel_entries_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fuel_entries_operator_id_fkey"
    FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "fuel_entries_receipt_attachment_id_fkey"
    FOREIGN KEY ("receipt_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- The office reads this newest-first, per company, and filters by asset; the
-- reverse-lookup indexes keep the FKs from sequential-scanning.
CREATE INDEX "fuel_entries_company_id_filled_at_idx" ON "fuel_entries" ("company_id", "filled_at" DESC);
CREATE INDEX "fuel_entries_company_id_asset_id_idx"  ON "fuel_entries" ("company_id", "asset_id");
CREATE INDEX "fuel_entries_operator_id_idx"          ON "fuel_entries" ("operator_id");
CREATE INDEX "fuel_entries_receipt_attachment_id_idx" ON "fuel_entries" ("receipt_attachment_id");

GRANT SELECT, INSERT, UPDATE ON "fuel_entries" TO fleetos_app;
ALTER TABLE "fuel_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "fuel_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "fuel_entries"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
