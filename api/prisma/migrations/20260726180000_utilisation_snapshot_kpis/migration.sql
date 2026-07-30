-- Extend the daily snapshot to record the other Operations-snapshot KPIs, so the
-- dashboard can show a real "vs yesterday" delta on each tile — computed against
-- a genuine prior-day average, never a fabricated baseline.
ALTER TABLE "utilisation_snapshots"
  ADD COLUMN "workshop_sum"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "defects_sum"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "services_due_sum" INTEGER NOT NULL DEFAULT 0;
