-- Live operator location (05-Dispatch/Dispatch_Overview.md "where is my driver now").
-- Latest position only — live telemetry, not a Timeline breadcrumb trail. Personal
-- information under the Privacy Act; the erasure path clears these columns.
ALTER TABLE "operators"
  ADD COLUMN "last_lat" DOUBLE PRECISION,
  ADD COLUMN "last_lng" DOUBLE PRECISION,
  ADD COLUMN "last_location_at" TIMESTAMP(3);
