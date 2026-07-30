-- Fix: PostgresError 22P02 "invalid input syntax for type uuid: """ under
-- normal use (found by running the full test suite against a real Postgres,
-- not by inspection).
--
-- Root cause: `current_setting('app.x', true)` only returns true NULL if
-- `app.x` has *never* been referenced on the current backend connection. Once
-- any transaction sets it via `set_config('app.x', value, true)` (SET LOCAL
-- semantics) and that transaction ends, the setting doesn't revert to NULL —
-- it reverts to an empty string. Prisma's connection pool reuses connections
-- across unrelated transactions, so a connection that previously ran
-- PrismaService.withUser (which sets app.current_user_id but not
-- app.current_company_id) leaves app.current_user_id permanently "touched"
-- on that connection. A later, unrelated withTenant transaction on the same
-- pooled connection then hits `current_setting('app.current_user_id',
-- true)::uuid` inside a policy (e.g. company_memberships', referenced
-- transitively by any query that joins into it) and gets `''::uuid`, which
-- Postgres rejects — not the NULL a naive reading of "missing_ok" suggests.
--
-- Fix: every RLS policy in this codebase now reads session GUCs through
-- `NULLIF(current_setting(..., true), '')::uuid`, which treats "touched but
-- reset to empty string" the same as "never set" — both correctly deny by
-- default rather than erroring.

DROP POLICY tenant_isolation ON companies;
CREATE POLICY tenant_isolation ON companies
  USING (
    id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM company_memberships cm
      WHERE cm.company_id = companies.id
        AND cm.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND cm.archived_at IS NULL
    )
  )
  WITH CHECK (id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON company_memberships;
CREATE POLICY tenant_isolation ON company_memberships
  USING (
    company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  )
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON roles;
CREATE POLICY tenant_isolation ON roles
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON role_permissions;
CREATE POLICY tenant_isolation ON role_permissions
  USING (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM roles r
      WHERE r.id = role_permissions.role_id
        AND r.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    )
  );

DROP POLICY tenant_isolation ON assets;
CREATE POLICY tenant_isolation ON assets
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON operators;
CREATE POLICY tenant_isolation ON operators
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON attached_units;
CREATE POLICY tenant_isolation ON attached_units
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON timeline_events;
CREATE POLICY tenant_isolation ON timeline_events
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

DROP POLICY tenant_isolation ON graph_relationships;
CREATE POLICY tenant_isolation ON graph_relationships
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);
