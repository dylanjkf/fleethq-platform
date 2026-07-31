-- Customer session & device management (Authentication Platform Phase 1).
--
-- Mirrors admin_sessions/admin_trusted_devices exactly, for customer User
-- accounts instead of AdminUser — see the model doc comments in
-- schema.prisma for the reasoning. Hand-written (not `prisma migrate dev`'s
-- raw diff) to avoid pulling in unrelated pre-existing schema drift on other
-- tables that a full shadow-DB diff picks up.

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT,
    "device_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_trusted_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "label" TEXT,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_user_id_idx" ON "user_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_trusted_devices_user_id_device_fingerprint_key" ON "user_trusted_devices"("user_id", "device_fingerprint");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_trusted_devices" ADD CONSTRAINT "user_trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Touched only by the pre-tenant-context fleetos_auth role (login runs before
-- any tenant context exists) — the same treatment `users`/`auth_tokens` get.
GRANT SELECT, INSERT, UPDATE ON "user_sessions" TO fleetos_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_trusted_devices" TO fleetos_auth;
