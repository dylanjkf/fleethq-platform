-- The background scheduler (SchedulerService, opt-in via SCHEDULER_ENABLED)
-- must enumerate companies to run per-tenant periodic tasks (notification
-- digests). It reuses the existing BYPASSRLS `fleetos_auth` role — the only
-- privileged runtime role — for a read-only company-id list. This widens that
-- role from "SELECT on users only" to also allow SELECT on companies; still
-- read-only, still no write access anywhere. See SystemPrismaService's doc.
GRANT SELECT ON "companies" TO fleetos_auth;
