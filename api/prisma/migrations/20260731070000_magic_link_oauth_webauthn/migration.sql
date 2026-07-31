-- Auth/Billing Platform Phase 2: magic link, social login, WebAuthn/passkeys.
--
-- Hand-written (not `prisma migrate dev`'s raw diff), same reasoning as the
-- Phase 1 migration: avoids pulling in unrelated pre-existing schema drift on
-- other tables that a full shadow-DB diff picks up.

-- AlterEnum: a single-use passwordless-login link, alongside the existing
-- EMAIL_VERIFY/PASSWORD_RESET token types.
ALTER TYPE "AuthTokenType" ADD VALUE 'MAGIC_LINK';

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'MICROSOFT');

-- CreateTable
CREATE TABLE "user_oauth_identities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_oauth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_webauthn_credentials" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "device_label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_oauth_identities_provider_provider_subject_key" ON "user_oauth_identities"("provider", "provider_subject");

-- CreateIndex
CREATE INDEX "user_oauth_identities_user_id_idx" ON "user_oauth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_webauthn_credentials_credential_id_key" ON "user_webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "user_webauthn_credentials_user_id_idx" ON "user_webauthn_credentials"("user_id");

-- AddForeignKey
ALTER TABLE "user_oauth_identities" ADD CONSTRAINT "user_oauth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_webauthn_credentials" ADD CONSTRAINT "user_webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Touched only by the pre-tenant-context fleetos_auth role (login/enrolment
-- runs before any tenant context exists) — the same treatment
-- `users`/`auth_tokens`/`user_sessions` get.
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_oauth_identities" TO fleetos_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_webauthn_credentials" TO fleetos_auth;
