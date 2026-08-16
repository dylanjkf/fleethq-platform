-- Row-level security for multi-tenancy.
--
-- 11-Database/Data_Model.md, non-negotiable constraint: "every table that holds
-- company-scoped data carries a company_id, enforced via row-level access control
-- at the data layer, not solely application-layer filtering."
--
-- Mechanism: a dedicated, low-privilege runtime role (fleetos_app) that the API
-- connects as. It is NOT the table owner and does not have BYPASSRLS, so every
-- policy below actually applies to it. The migration/owner role (whatever
-- DATABASE_URL points at) keeps full access for `prisma migrate` and admin tooling.
--
-- Session context: the app sets two Postgres GUCs per request via set_config(...,
-- true) inside a transaction (see src/prisma/prisma.service.ts):
--   app.current_company_id — the tenant a request is scoped to (the common case).
--   app.current_user_id    — set during login/company-selection, before a tenant
--                             context exists yet, so a user can discover which
--                             companies they belong to without a blanket RLS bypass.
-- Both use current_setting(..., true) (missing_ok), so an unset GUC is NULL and
-- every policy below fails closed rather than open.

-- ---------------------------------------------------------------------------
-- Runtime role
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleetos_app') THEN
    CREATE ROLE fleetos_app LOGIN PASSWORD 'fleetos_app_dev_only';
  END IF;
END
$$;

-- Grant CONNECT on whichever database this migration runs against. Hardcoding
-- the name ("fleetos") failed on hosts where the database has a different name
-- (e.g. Railway names it "railway"), which aborted this migration and blocked
-- every migration after it. current_database() makes it portable.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO fleetos_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO fleetos_app;

-- Global reference catalogs: read-only for the app, no RLS (not tenant data).
GRANT SELECT ON permissions TO fleetos_app;
GRANT SELECT ON asset_classes TO fleetos_app;

-- Identity: no RLS (see note below) — read/write needed for login + provisioning.
GRANT SELECT, INSERT, UPDATE ON users TO fleetos_app;

-- Tenant-scoped tables. No DELETE anywhere except role_permissions: "no hard
-- deletes on entities with Timeline/compliance relevance — archiving preserves
-- history" (Data_Model.md). Attaching/detaching a permission from a role is
-- ordinary config editing, not an entity mutation that needs history.
GRANT SELECT, INSERT, UPDATE ON companies TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON company_memberships TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON roles TO fleetos_app;
GRANT SELECT, INSERT, DELETE ON role_permissions TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON assets TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON operators TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON attached_units TO fleetos_app;
GRANT SELECT, INSERT, UPDATE ON graph_relationships TO fleetos_app;

-- Timeline is append-only: SELECT and INSERT only. No UPDATE/DELETE grant at all,
-- so "no Timeline entry can be edited or deleted through any part of the product"
-- (01-Product/Timelines.md acceptance criteria) holds structurally, not just by
-- convention — there is no code path, buggy or otherwise, that could issue an
-- UPDATE/DELETE the database would actually accept.
GRANT SELECT, INSERT ON timeline_events TO fleetos_app;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- companies: a request can only see the single company it's scoped to. Matched
-- against the table's own primary key, not a company_id column.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON companies
  USING (id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_company_id', true)::uuid);

-- company_memberships: visible either within the current tenant context, OR to
-- the authenticated user's own membership rows (so login/company-selection can
-- discover which companies to offer, before a tenant context is chosen). Writes
-- are still confined to the current tenant context — the user-id clause is
-- read-only in effect because WITH CHECK omits it.
ALTER TABLE company_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_memberships
  USING (
    company_id = current_setting('app.current_company_id', true)::uuid
    OR user_id = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

-- role_permissions has no company_id column of its own — scope it via the role
-- it belongs to. Slightly more expensive than a direct column check, but this is
-- a small, low-cardinality table (roles x permissions), not a hot path.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = current_setting('app.current_company_id', true)::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = current_setting('app.current_company_id', true)::uuid
    )
  );

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assets
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operators
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE attached_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE attached_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attached_units
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE timeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE timeline_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timeline_events
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

ALTER TABLE graph_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON graph_relationships
  USING (company_id = current_setting('app.current_company_id', true)::uuid)
  WITH CHECK (company_id = current_setting('app.current_company_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- Known, deliberate gap: `users` has no row-level security.
-- ---------------------------------------------------------------------------
-- A User is a cross-company login identity by design (Permissions_Model.md:
-- "a user can belong to multiple companies... under one login") — it has no
-- company_id column to scope by, so per-tenant RLS doesn't fit it directly.
-- This foundation milestone only reads `users` for username lookup at login,
-- which is not tenant business data. It does NOT ship a user-listing or
-- user-management API. Before building Administration (07-FleetHQ/
-- FleetHQ_Overview.md's "users, roles/permissions" area), this needs a real
-- answer — most likely restricting which User rows a request can see to those
-- who share a CompanyMembership with the current tenant. Flagged here rather
-- than silently building on top of it later.
