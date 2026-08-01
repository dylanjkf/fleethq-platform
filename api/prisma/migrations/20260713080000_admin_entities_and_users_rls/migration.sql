-- Administration API groundwork: Timeline coverage for User/Role/Company
-- entities, and the "real answer" for the users-table RLS gap flagged in
-- 11-Database/Data_Model.md's implementation notes when the foundation
-- milestone shipped.

-- Company_Principles.md #3 "everything has a timeline" applies to
-- administration actions too (a user being added, a role's permissions
-- changing, a company's profile being edited), not just fleet entities.
ALTER TYPE "TimelineEntityType" ADD VALUE 'USER';
ALTER TYPE "TimelineEntityType" ADD VALUE 'ROLE';
ALTER TYPE "TimelineEntityType" ADD VALUE 'COMPANY';

-- ---------------------------------------------------------------------------
-- users: row-level security
-- ---------------------------------------------------------------------------
-- A User is a cross-company login identity with no company_id column, so it
-- can't be scoped the same way as assets/operators/etc. The correct scope is
-- "visible if you share an active CompanyMembership with the requesting
-- tenant" — i.e. you can see (and, via the app's permission checks, manage)
-- users who are members of your own company, and nothing else.
--
-- This deliberately does NOT solve login's username lookup — see fleetos_auth
-- below for why that's a separate, narrower mechanism rather than a hole in
-- this policy.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (
    EXISTS (
      SELECT 1 FROM company_memberships cm
      WHERE cm.user_id = users.id
        AND cm.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
        AND cm.archived_at IS NULL
    )
  )
  -- No per-row constraint to express on INSERT: `users` has no company_id of
  -- its own, and the real tenant boundary is the paired company_memberships
  -- INSERT (which does have a WITH CHECK) plus the users:create permission
  -- check at the API layer. Restricting WITH CHECK here would just block the
  -- (legitimate) "create a brand-new user, then immediately add them to my
  -- company in the same transaction" flow, since the membership row that
  -- would prove tenancy doesn't exist yet at the moment `users` is inserted.
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- fleetos_auth: a second, even narrower runtime role
-- ---------------------------------------------------------------------------
-- Login's very first step — "find the user with this username, so I can
-- check their password" — happens before any tenant OR user context exists;
-- it's the query that *establishes* app.current_user_id, so it structurally
-- cannot be scoped by app.current_user_id the way the company_memberships
-- dual-condition policy scopes the next step. Something has to be able to
-- read across all tenants for this one lookup.
--
-- Rather than give fleetos_app (or the running app process generally) that
-- power, fleetos_auth is BYPASSRLS but deliberately narrow. This migration
-- establishes it with SELECT on `users` (the login lookup) and nothing else.
-- Later migrations extend it — still narrowly — with the specific grants the
-- pre-/cross-tenant auth and background paths need: SELECT on `companies`
-- (scheduler enumeration), column-scoped UPDATE on `users`
-- (password/lockout/MFA/token-version fields only), and table-scoped DML on the
-- auth/background tables (auth_tokens, user_sessions, user_trusted_devices,
-- user_oauth_identities, user_webauthn_credentials, user_password_history,
-- audit_logs, scheduler_leases, gps_devices/gps_pings, stripe_webhook_events).
-- Each is granted explicitly with its own `GRANT ... TO fleetos_auth` in the
-- migration that adds the feature — it never becomes a schema owner or gains
-- blanket read/write. Used by AuthService's username lookup and the handful of
-- pre-tenant/background writes (see src/prisma/system-prisma.service.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleetos_auth') THEN
    CREATE ROLE fleetos_auth LOGIN PASSWORD 'fleetos_auth_dev_only' BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE fleetos TO fleetos_auth;
GRANT USAGE ON SCHEMA public TO fleetos_auth;
GRANT SELECT ON users TO fleetos_auth;
