-- Multi-factor authentication (TOTP) for user accounts.
--
-- mfa_secret        : the base32 TOTP shared secret (null until enrolment).
-- mfa_enabled_at    : set once the user confirms a code — MFA is only *active*
--                     when this is non-null (a secret alone is a pending, un-
--                     confirmed enrolment and is never enforced at login).
-- mfa_backup_codes  : bcrypt hashes of single-use recovery codes, shown once at
--                     enrolment; a used code is removed from the array.
ALTER TABLE "users" ADD COLUMN "mfa_secret" TEXT;
ALTER TABLE "users" ADD COLUMN "mfa_enabled_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "mfa_backup_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Enrolment / verification run through the pre-tenant fleetos_auth role (like
-- password reset), so it needs column-scoped UPDATE on the new columns. Its
-- table-level SELECT already covers reads.
GRANT UPDATE ("mfa_secret", "mfa_enabled_at", "mfa_backup_codes") ON "users" TO fleetos_auth;
