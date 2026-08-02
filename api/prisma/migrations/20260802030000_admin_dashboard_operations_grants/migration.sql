-- Executive-dashboard operations KPIs (inspections + open defects).
--
-- The admin analytics overview now counts checklist/form submissions ("inspections")
-- and non-complete maintenance jobs ("open defects") across every tenant. The admin
-- runtime role fleetos_admin is BYPASSRLS but only holds the table-level grants it has
-- been given explicitly (assets/operators were granted for the cross-tenant fleet views;
-- these three were not). Grant read-only SELECT so AdminAnalyticsService.overview can
-- aggregate them. Read-only by design — the admin console never writes tenant fleet data.
GRANT SELECT ON "checklist_submissions" TO fleetos_admin;
GRANT SELECT ON "form_submissions" TO fleetos_admin;
GRANT SELECT ON "maintenance_jobs" TO fleetos_admin;
