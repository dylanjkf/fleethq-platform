-- Account-security remediation: make WebAuthn challenges single-use.
--
-- WebAuthn challenges are stateless, short-lived signed JWTs — their ~2-minute
-- expiry bounds validity but does nothing to stop a captured, still-unexpired
-- challenge from being replayed a second time inside that window. This table is
-- the single-use marker: the SHA-256 hash of the random challenge nonce is
-- inserted under a unique constraint the first time the challenge is redeemed,
-- so any second redemption collides and is rejected (see WebauthnService).
--
-- Hand-written (not `prisma migrate dev`'s raw diff), same reasoning as the
-- surrounding auth migrations: avoids pulling in unrelated pre-existing schema
-- drift on other tables that a full shadow-DB diff picks up.

-- CreateTable
CREATE TABLE "webauthn_challenge_consumptions" (
    "id" UUID NOT NULL,
    "challenge_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webauthn_challenge_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_challenge_consumptions_challenge_hash_key" ON "webauthn_challenge_consumptions"("challenge_hash");

-- CreateIndex
CREATE INDEX "webauthn_challenge_consumptions_expires_at_idx" ON "webauthn_challenge_consumptions"("expires_at");

-- Touched only by the pre-tenant-context fleetos_auth role (passkey enrolment
-- and usernameless login both run before any tenant context exists) — the same
-- treatment `users`/`auth_tokens`/`user_sessions`/`user_webauthn_credentials`
-- get. No RLS: there is no tenant to scope a redeemed-challenge marker by.
GRANT SELECT, INSERT, UPDATE, DELETE ON "webauthn_challenge_consumptions" TO fleetos_auth;
