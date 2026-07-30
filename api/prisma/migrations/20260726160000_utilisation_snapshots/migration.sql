-- Daily fleet-utilisation snapshots: one accumulating row per company per day.
--
-- The Fleet utilisation dashboard widget shows a live "% of the fleet on an
-- active job right now" gauge. To turn that into a real trend WITHOUT ever
-- back-filling invented history, the scheduler folds the current busy/active
-- counts into today's row on each tick — busy_sum / active_sum is then a true
-- weighted average for the day, and the trend grows one honest point at a time.

CREATE TABLE "utilisation_snapshots" (
  "id"           UUID    NOT NULL DEFAULT gen_random_uuid(),
  "company_id"   UUID    NOT NULL,
  "day"          DATE    NOT NULL,
  "busy_sum"     INTEGER NOT NULL DEFAULT 0,
  "active_sum"   INTEGER NOT NULL DEFAULT 0,
  "sample_count" INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "utilisation_snapshots_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "utilisation_snapshots"
  ADD CONSTRAINT "utilisation_snapshots_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One row per (company, day); the scheduler upserts into it.
CREATE UNIQUE INDEX "utilisation_snapshots_company_id_day_key"
  ON "utilisation_snapshots"("company_id", "day");
-- Trend read: last N days for one company, chronological.
CREATE INDEX "utilisation_snapshots_company_id_day_idx"
  ON "utilisation_snapshots"("company_id", "day");

-- Same RLS pattern as every tenant table: visible/writable only within the
-- caller's company, FORCEd so even the table owner is subject to it.
ALTER TABLE "utilisation_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "utilisation_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "utilisation_snapshots_tenant_isolation" ON "utilisation_snapshots"
  USING ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- The runtime role needs table privileges (RLS narrows rows, it does not grant
-- access). The scheduler both inserts and updates the accumulating row.
GRANT SELECT, INSERT, UPDATE ON "utilisation_snapshots" TO fleetos_app;
