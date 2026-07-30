-- A2 auth completeness: email verification, password reset, invite, login lockout.

CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

ALTER TABLE "users"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "email_verified_at" TIMESTAMP(3),
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMP(3);

CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens"("user_id", "type");
CREATE INDEX "auth_tokens_token_hash_idx" ON "auth_tokens"("token_hash");

ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The pre-auth flows (forgot/reset/verify/lockout) run as fleetos_auth, the
-- BYPASSRLS role that already reads `users` for login. Give it exactly the
-- extra reach these flows need and nothing more:
--  * full access to auth_tokens (it's the only role that ever touches them)
--  * column-scoped UPDATE on users, so a leak of this role can rewrite a
--    password/verification/lock state but not, say, someone's username.
GRANT SELECT, INSERT, UPDATE ON "auth_tokens" TO fleetos_auth;
GRANT UPDATE ("password_hash", "email", "email_verified_at", "failed_login_count", "locked_until", "updated_at") ON "users" TO fleetos_auth;
