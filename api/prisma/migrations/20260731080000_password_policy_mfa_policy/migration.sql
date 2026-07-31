-- Auth/Billing Platform Phase 3: password policy depth (history reuse-
-- prevention, expiry) + per-company mandatory-MFA policy.
--
-- Hand-written (not `prisma migrate dev`'s raw diff), same reasoning as the
-- Phase 1/2 migrations: avoids pulling in unrelated pre-existing schema drift
-- on other tables that a full shadow-DB diff picks up.

-- Every existing row's current password becomes its own "changed at" instant
-- as of this migration — that's the only honest value available (the actual
-- set-time was never recorded before now), and it means no pre-existing
-- account is retroactively treated as overdue for rotation the moment a
-- company opts into a passwordExpiryDays policy.
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- fleetos_auth's grant on "users" is column-level (see auth_completeness /
-- user_token_version / user_mfa migrations) — a new writable column needs
-- its own explicit grant, or every password-set write path 500s with
-- "permission denied for table users".
GRANT UPDATE ("password_changed_at") ON "users" TO fleetos_auth;

-- CreateTable: hashes that were once a user's active password (reuse-prevention).
CREATE TABLE "user_password_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_password_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_password_history_user_id_created_at_idx" ON "user_password_history"("user_id", "created_at");
ALTER TABLE "user_password_history" ADD CONSTRAINT "user_password_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Touched only by the pre-tenant-context fleetos_auth role (password changes
-- run before any tenant context exists) — the same treatment `users`/
-- `auth_tokens`/`user_sessions` already get.
GRANT SELECT, INSERT, DELETE ON "user_password_history" TO fleetos_auth;

-- CreateTable: per-company MFA/password policy (absent row = platform defaults).
CREATE TABLE "company_security_settings" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "mfa_required" BOOLEAN NOT NULL DEFAULT false,
    "password_expiry_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_security_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "company_security_settings_company_id_key" ON "company_security_settings"("company_id");
ALTER TABLE "company_security_settings" ADD CONSTRAINT "company_security_settings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unlike every other per-company settings table (analytics_settings,
-- barcode_scan_configs), this one must also be readable from the pre-tenant
-- login path (AuthService resolves it via PrismaService.withUser, right
-- alongside the Company row, to decide whether a login needs to be
-- redirected into forced MFA enrolment / a forced password change before a
-- session is issued). So its RLS policy mirrors `companies`' own two-branch
-- policy exactly, not the plain single-branch shape every other settings
-- table uses.
ALTER TABLE "company_security_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_security_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "company_security_settings"
  USING (
    "company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    OR EXISTS (
      SELECT 1 FROM "company_memberships" cm
      WHERE cm.company_id = "company_security_settings"."company_id"
        AND cm.user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
        AND cm.archived_at IS NULL
    )
  )
  WITH CHECK ("company_id" = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "company_security_settings" TO fleetos_app;
