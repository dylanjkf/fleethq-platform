-- Cockpit cross-tenant search (B1) adds job/load-reference lookup: AdminSearchService
-- now probes jobs.title with a case-insensitive `contains` (leading-wildcard ILIKE)
-- across ALL tenants. Like the other admin-search columns, back it with a pg_trgm
-- GIN index so the cross-tenant probe stays index-backed rather than a full scan of
-- every tenant's jobs. (pg_trgm extension already created by the admin-search
-- trigram migration; IF NOT EXISTS keeps this safe regardless.)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "jobs_title_trgm_idx"
  ON "jobs" USING gin ("title" gin_trgm_ops);

-- The admin surface (AdminSearchService, cockpit) reads jobs cross-tenant via the
-- narrow-grant fleetos_admin role. Grant it SELECT on jobs (it already has
-- companies/users/assets/company_memberships) so the job/load search can run.
GRANT SELECT ON "jobs" TO fleetos_admin;

-- Cockpit B2 (customer 360) surfaces a "last active" signal from the tenant's
-- session history. Grant the narrow fleetos_admin role SELECT on user_sessions
-- for that read-only aggregate (max last_seen_at per company).
GRANT SELECT ON "user_sessions" TO fleetos_admin;

-- Cockpit B4 (system & ops health) surfaces a coarse scheduler-health panel from
-- the leader-election lease table (task / holder / last-claimed). Grant the
-- narrow fleetos_admin role SELECT so the health read stays on the admin role.
GRANT SELECT ON "scheduler_leases" TO fleetos_admin;
