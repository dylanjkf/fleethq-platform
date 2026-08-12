-- Self-service password reset for FleetHQ staff admins (admin console).
-- The admin-scoped mirror of `auth_tokens`: single-use, expiring, hash-only
-- tokens behind the emailed reset link. Lives in the admin_* table space and
-- is touched only by the BYPASSRLS `fleetos_admin` runtime role.

-- CreateEnum
CREATE TYPE "AdminAuthTokenType" AS ENUM ('PASSWORD_RESET');

-- CreateTable
CREATE TABLE "admin_auth_tokens" (
    "id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "type" "AdminAuthTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_auth_tokens_token_hash_key" ON "admin_auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "admin_auth_tokens_admin_user_id_type_idx" ON "admin_auth_tokens"("admin_user_id", "type");

-- AddForeignKey
ALTER TABLE "admin_auth_tokens" ADD CONSTRAINT "admin_auth_tokens_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The admin runtime role owns full CRUD on its own admin_* tables (mirrors the
-- grants the foundation migration made for admin_sessions/admin_trusted_devices).
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_auth_tokens" TO fleetos_admin;
