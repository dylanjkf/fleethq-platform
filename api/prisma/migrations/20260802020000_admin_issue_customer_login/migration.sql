-- Admin "issue a new customer login" feature.

-- 1. Force-a-password-change flag. Set when FleetHQ staff issue an account with
--    a temporary password; the login policy gate turns it into the existing
--    `password_expired` block, and `changeExpiredPassword` clears it, so a
--    handed-over temporary credential can't be reused past first sign-in.
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- fleetos_auth holds only column-level UPDATE on users; it clears this flag when
-- the customer completes the forced change (AuthService.changeExpiredPassword),
-- so it needs UPDATE on this new column too. (fleetos_admin already has
-- table-level INSERT/UPDATE on users, so it can set it at account creation.)
GRANT UPDATE ("must_change_password") ON "users" TO fleetos_auth;

-- 2. Let the runtime admin role provision a brand-new customer org + its first
--    login in one transaction (AdminOrganisationsService.createOrganisation ->
--    provisionCompany). fleetos_admin (BYPASSRLS) already had INSERT on users and
--    company_memberships; provisionCompany also inserts the Company, its named
--    system Roles, and their RolePermission rows, so it needs INSERT on those
--    three tables too. (It already holds SELECT/UPDATE on companies + roles.)
GRANT INSERT ON "companies" TO fleetos_admin;
GRANT INSERT ON "roles" TO fleetos_admin;
GRANT INSERT ON "role_permissions" TO fleetos_admin;
