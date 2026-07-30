-- Fix: deactivating a user made them disappear entirely, including from the
-- very response confirming the deactivation.
--
-- The users RLS policy's EXISTS check required `cm.archived_at IS NULL` — but
-- POST /v1/users/:id/deactivate archives the CompanyMembership and then reads
-- it back with the linked `user` (`include: { user: true }`) to return the
-- updated record. Prisma's `.update()` also does `RETURNING`/a follow-up read,
-- which re-checks SELECT visibility — and by the time that check runs, the
-- membership being archived is the user's only one in this company, so the
-- EXISTS condition (which required an *active* membership) had just gone
-- false, on the same row we were trying to confirm the archive of. Found by
-- actually running the deactivate test against a real Postgres instance.
--
-- Fix: a company can see a user if they've *ever* had a membership there,
-- active or archived — the same way an archived Asset or Operator is still
-- visible by default (default listing just excludes it), rather than an
-- archived row vanishing from view entirely. Whether to *list* deactivated
-- users by default remains an application-layer choice (UsersService's
-- includeArchived flag); this is about whether the row can be seen at all.
DROP POLICY tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (
    EXISTS (
      SELECT 1 FROM company_memberships cm
      WHERE cm.user_id = users.id
        AND cm.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    )
  )
  WITH CHECK (true);
