-- FleetHQ Internal Administration Platform — foundation slice
-- (20-Admin-Platform/Overview.md). See schema.prisma's header comment on this
-- section for the isolation guarantees this migration establishes.
--
-- Note: only the admin-platform-specific changes are included below (the
-- new `companies` columns and the new `admin_*` tables/indexes/foreign
-- keys). `prisma migrate dev`'s auto-generated diff also proposed dropping
-- and re-adding several unrelated foreign keys and column defaults on
-- pre-existing tables — that's schema drift local to this sandbox's dev
-- database (not present against a cleanly-migrated database), not a real
-- change this migration should make, so it's deliberately excluded here.

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspension_reason" TEXT;

-- CreateTable
CREATE TABLE "admin_permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_roles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_system_template" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_role_permissions" (
    "id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "admin_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "mfa_secret" TEXT,
    "mfa_enabled_at" TIMESTAMP(3),
    "mfa_backup_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "must_reset_password" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "device_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_trusted_devices" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "label" TEXT,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_login_attempts" (
    "id" UUID NOT NULL,
    "username_tried" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "success" BOOLEAN NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "organisation_id" UUID,
    "before_value" JSONB,
    "after_value" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_permissions_key_key" ON "admin_permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "admin_roles_name_key" ON "admin_roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "admin_role_permissions_role_id_permission_id_key" ON "admin_role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE INDEX "admin_sessions_admin_user_id_idx" ON "admin_sessions"("admin_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_trusted_devices_admin_user_id_device_fingerprint_key" ON "admin_trusted_devices"("admin_user_id", "device_fingerprint");

-- CreateIndex
CREATE INDEX "admin_login_attempts_ip_address_created_at_idx" ON "admin_login_attempts"("ip_address", "created_at");

-- CreateIndex
CREATE INDEX "admin_login_attempts_username_tried_created_at_idx" ON "admin_login_attempts"("username_tried", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_admin_user_id_created_at_idx" ON "admin_audit_logs"("admin_user_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_organisation_id_created_at_idx" ON "admin_audit_logs"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_logs_entity_type_entity_id_idx" ON "admin_audit_logs"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_role_permissions" ADD CONSTRAINT "admin_role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "admin_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "admin_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_trusted_devices" ADD CONSTRAINT "admin_trusted_devices_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- fleetos_admin: the third and most privileged runtime role, used
-- exclusively by the isolated admin API surface (never the customer-facing
-- API, never reachable via a customer JWT). Cross-tenant administration —
-- "list every organisation", "this admin's MRR dashboard" — is fundamentally
-- incompatible with the per-request `app.current_company_id` RLS policies
-- every other table enforces, so this role is BYPASSRLS, same mechanism as
-- fleetos_auth's narrower bypass. The difference from fleetos_auth is scope,
-- not the bypass itself: fleetos_auth can only SELECT one table
-- pre-tenant-context; fleetos_admin has the read/write the admin platform
-- actually needs across tenant tables, granted explicitly table-by-table
-- below, not blanket schema ownership.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleetos_admin') THEN
    CREATE ROLE fleetos_admin LOGIN PASSWORD 'fleetos_admin_dev_only' BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE fleetos TO fleetos_admin;
GRANT USAGE ON SCHEMA public TO fleetos_admin;

-- Full CRUD on the admin platform's own tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_permissions TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_roles TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_role_permissions TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_users TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_trusted_devices TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_login_attempts TO fleetos_admin;
GRANT SELECT, INSERT ON admin_audit_logs TO fleetos_admin;

-- Cross-tenant read/write on the tenant tables the admin platform's
-- organisation/user/fleet management and dashboards actually touch. No
-- DELETE anywhere here either — same "no hard deletes" posture as
-- fleetos_app; organisation/user removal is the existing archivedAt /
-- suspendedAt soft-delete pattern.
GRANT SELECT, UPDATE ON companies TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE ON users TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE ON company_memberships TO fleetos_admin;
GRANT SELECT, UPDATE ON roles TO fleetos_admin;
GRANT SELECT ON role_permissions TO fleetos_admin;
GRANT SELECT ON permissions TO fleetos_admin;
GRANT SELECT ON assets TO fleetos_admin;
GRANT SELECT ON operators TO fleetos_admin;
GRANT SELECT ON attached_units TO fleetos_admin;
GRANT SELECT, INSERT ON timeline_events TO fleetos_admin;
