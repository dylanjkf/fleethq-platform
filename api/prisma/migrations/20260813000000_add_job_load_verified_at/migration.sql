-- Load verification (item 2). Set when a driver has verified the vehicle's
-- actual load against the run's expected manifest (its stops' stop_parcels)
-- before starting — cleanly, or by explicitly overriding a discrepancy. Null
-- means verification hasn't happened yet. The who/when/what-was-missing of an
-- override is recorded on the JOB timeline (load_discrepancy_override); this
-- column is only the "done" flag the DriverOS client reads.
ALTER TABLE "jobs" ADD COLUMN "load_verified_at" TIMESTAMP(3);
