-- New-device-login alert scoping (A3). A nullable hashed device fingerprint on
-- each session so a later login from the same device isn't flagged as "new"
-- (fixing shared-tablet / rotating-IP alert noise). Used ONLY for the alert
-- decision — it is NOT a trusted-device / MFA-skip signal. Nullable so clients
-- that don't send a fingerprint keep working unchanged. Existing table grants
-- (SELECT/INSERT/UPDATE to fleetos_auth) cover the new column.
ALTER TABLE "user_sessions"
  ADD COLUMN "device_fingerprint" TEXT;

-- Supports the "have we seen this (user, fingerprint) before?" lookup.
CREATE INDEX "user_sessions_user_id_device_fingerprint_idx"
  ON "user_sessions" ("user_id", "device_fingerprint");
