-- GpsPing retention-purge support (audit M10).
-- The daily purge deletes pings older than a 540-day window, filtering on
-- recorded_at over the whole table. Without this index that scan is a full-table
-- scan whose cost grows unbounded with ping volume; with it, it is a range scan.
CREATE INDEX "gps_pings_recorded_at_idx" ON "gps_pings"("recorded_at");
