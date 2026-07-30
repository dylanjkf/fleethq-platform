-- Universal GPS tracker ingest: hardware devices (not phones) that POST a
-- position authenticated by their own secret device key, optionally bound to
-- an asset. Deliberately NOT row-level-security-protected: ingest is a keyless
-- lookup by the unique device_key (it must resolve a tenant before any company
-- context exists), so isolation is enforced in the service layer instead —
-- every user-facing query filters by company_id.
CREATE TABLE "gps_devices" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "device_key" TEXT NOT NULL,
  "provider" TEXT,
  "asset_id" UUID,
  "last_lat" DOUBLE PRECISION,
  "last_lng" DOUBLE PRECISION,
  "last_location_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "gps_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gps_devices_device_key_key" ON "gps_devices" ("device_key");
CREATE INDEX "gps_devices_company_id_idx" ON "gps_devices" ("company_id");
ALTER TABLE "gps_devices" ADD CONSTRAINT "gps_devices_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gps_devices" ADD CONSTRAINT "gps_devices_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "gps_pings" (
  "id" UUID NOT NULL,
  "company_id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "lat" DOUBLE PRECISION NOT NULL,
  "lng" DOUBLE PRECISION NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gps_pings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gps_pings_company_id_device_id_idx" ON "gps_pings" ("company_id", "device_id");
ALTER TABLE "gps_pings" ADD CONSTRAINT "gps_pings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gps_pings" ADD CONSTRAINT "gps_pings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "gps_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON gps_devices TO fleetos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON gps_pings TO fleetos_app;
