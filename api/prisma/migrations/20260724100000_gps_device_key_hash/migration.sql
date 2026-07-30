-- Store only a SHA-256 hash of each GPS device's bearer key, never the
-- plaintext. The key is high-entropy (32 random bytes), so a fast deterministic
-- hash is safe *and* indexable — ingest resolves the tenant by hashing the
-- presented key and looking it up.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "gps_devices" ADD COLUMN "device_key_hash" TEXT;

-- Backfill: hash whatever plaintext keys exist (dev/demo data — no production
-- devices yet). digest() comes from pgcrypto.
UPDATE "gps_devices" SET "device_key_hash" = encode(digest("device_key", 'sha256'), 'hex');

ALTER TABLE "gps_devices" ALTER COLUMN "device_key_hash" SET NOT NULL;

DROP INDEX IF EXISTS "gps_devices_device_key_key";
CREATE UNIQUE INDEX "gps_devices_device_key_hash_key" ON "gps_devices" ("device_key_hash");

-- The plaintext column is gone for good; the key is only ever shown once, at
-- registration/rotation, straight from the request that generated it.
ALTER TABLE "gps_devices" DROP COLUMN "device_key";
