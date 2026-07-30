-- Database-enforced tenant isolation for the GPS tables (defense in depth).
--
-- gps_devices and gps_pings carry company_id but were previously the only
-- tenant tables NOT protected by row-level security: the ingest path
-- authenticates by device key (no user/company context), so it could not use
-- the per-transaction `app.current_company_id` GUC that RLS relies on, and the
-- tables were left on application-level companyId filtering alone.
--
-- That is now hardened. Every USER-facing GPS query runs inside
-- prisma.withTenant(...) (which sets the GUC), so enabling RLS makes a forgotten
-- companyId filter fail closed instead of leaking one company's device or
-- position data to another. The device-key INGEST path is routed through the
-- BYPASSRLS `fleetos_auth` role (see gps.service.ts), which skips RLS by role
-- attribute even under FORCE — so it retains its necessary global device lookup
-- and cross-context writes.

-- Ingest runs as fleetos_auth: grant it exactly the DML the ingest path needs
-- (look up a device by key hash, update its last position, insert a ping).
GRANT SELECT, INSERT, UPDATE ON "gps_devices" TO fleetos_auth;
GRANT SELECT, INSERT, UPDATE ON "gps_pings" TO fleetos_auth;

ALTER TABLE "gps_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gps_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gps_devices"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

ALTER TABLE "gps_pings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gps_pings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "gps_pings"
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
