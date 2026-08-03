-- Admin Inspection Centre + Maintenance/Defect dashboard (read-only, cross-tenant).
--
-- The admin runtime role fleetos_admin already holds SELECT on checklist_submissions,
-- form_submissions and maintenance_jobs (the executive-dashboard operations grant).
-- The Inspection Centre also joins checklist_templates for the template name shown in
-- the list, so grant read-only SELECT on that table too. Read-only by design — the
-- admin console never writes tenant inspection or maintenance data in this pass.
GRANT SELECT ON "checklist_templates" TO fleetos_admin;
