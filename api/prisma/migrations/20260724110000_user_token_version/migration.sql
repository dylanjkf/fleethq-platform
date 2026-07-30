-- Session-revocation counter. Session JWTs embed the value at issue time; the
-- JWT strategy rejects a token whose embedded value no longer matches. Bumped
-- on a password reset so existing sessions are invalidated immediately.
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

-- The pre-context auth role writes users column-by-column (its UPDATE grant is
-- column-scoped, not table-wide); extend it to the new column so a password
-- reset can bump the version.
GRANT UPDATE ("token_version") ON "users" TO fleetos_auth;
