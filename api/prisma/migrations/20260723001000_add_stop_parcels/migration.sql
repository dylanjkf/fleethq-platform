-- Multi-parcel per delivery stop (barcode/consignment tracking). Optional per
-- stop; a stop with no parcels behaves exactly as before.
CREATE TABLE "stop_parcels" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "stop_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "label" TEXT,
    "scanned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stop_parcels_pkey" PRIMARY KEY ("id")
);

-- A parcel reference is unique within its stop (can't scan the same barcode twice).
CREATE UNIQUE INDEX "stop_parcels_stop_id_reference_key" ON "stop_parcels"("stop_id", "reference");
CREATE INDEX "stop_parcels_company_id_stop_id_idx" ON "stop_parcels"("company_id", "stop_id");

ALTER TABLE "stop_parcels" ADD CONSTRAINT "stop_parcels_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stop_parcels" ADD CONSTRAINT "stop_parcels_stop_id_fkey" FOREIGN KEY ("stop_id") REFERENCES "job_stops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: tenant-scoped and mutable (scanned_at set on scan). App role gets
-- SELECT/INSERT/UPDATE — no DELETE, consistent with the no-hard-deletes rule.
GRANT SELECT, INSERT, UPDATE ON stop_parcels TO fleetos_app;
ALTER TABLE stop_parcels ENABLE ROW LEVEL SECURITY;
ALTER TABLE stop_parcels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stop_parcels
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
