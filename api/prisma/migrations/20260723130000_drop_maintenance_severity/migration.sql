-- Maintenance severity (Normal/Critical) removed. Dispatch now warns on any
-- open maintenance job rather than grading it; the score/priority features that
-- leaned on severity were reworked to use fault age + open-count instead.
ALTER TABLE "maintenance_jobs" DROP COLUMN "severity";
DROP TYPE "MaintenanceSeverity";
