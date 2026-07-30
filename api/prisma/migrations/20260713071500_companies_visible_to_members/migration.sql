-- Fix: a user could not discover their own companies at login.
--
-- The `companies` RLS policy only allowed a row when `app.current_company_id`
-- already matched it — but at login time, before a tenant context has been
-- chosen, only `app.current_user_id` is set (see the company_memberships
-- policy's comment for the same reasoning). AuthService.login joins
-- CompanyMembership -> Company to show company names for the "choose a
-- company" step, and that join was silently coming back empty, which surfaced
-- as every login failing with NO_COMPANY_ACCESS even though the membership
-- row existed. Found by running the integration tests against a real
-- Postgres instance, not caught by anything that mocks the database.
--
-- Fix mirrors the company_memberships policy: a company is visible if it's
-- the current tenant context, OR the current user has an active membership
-- in it — nothing broader than that.
DROP POLICY tenant_isolation ON companies;

CREATE POLICY tenant_isolation ON companies
  USING (
    id = current_setting('app.current_company_id', true)::uuid
    OR EXISTS (
      SELECT 1 FROM company_memberships cm
      WHERE cm.company_id = companies.id
        AND cm.user_id = current_setting('app.current_user_id', true)::uuid
        AND cm.archived_at IS NULL
    )
  )
  WITH CHECK (id = current_setting('app.current_company_id', true)::uuid);
