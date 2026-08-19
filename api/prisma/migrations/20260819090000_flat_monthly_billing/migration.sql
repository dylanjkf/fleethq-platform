-- Flat monthly billing — FleetHQ moves OFF per-asset pricing to a single flat
-- $29/month rate for the whole account. Asset count is now purely operational
-- (it no longer drives billing and there is no asset cap tied to billing), so
-- the per-asset quantity column is dropped and the price field is renamed to a
-- flat price so its name is no longer misleading.

-- 1) billing_settings: rename price_per_asset_cents -> price_cents (the flat
--    account price for display/quotes), and reset the singleton row + default to
--    the new $29 rate. (The authoritative charge is always the Stripe Price; this
--    is the display figure, kept as one source of truth.)
ALTER TABLE "billing_settings" RENAME COLUMN "price_per_asset_cents" TO "price_cents";
ALTER TABLE "billing_settings" ALTER COLUMN "price_cents" SET DEFAULT 2900;
UPDATE "billing_settings" SET "price_cents" = 2900 WHERE id = 1;

-- 2) companies: the purchased per-asset quantity / hard cap no longer exists
--    under flat pricing. Drop it. (No data migration needed — it was only ever a
--    billing artifact, never operational asset data; the assets themselves live
--    in the assets table and are untouched.)
ALTER TABLE "companies" DROP COLUMN IF EXISTS "asset_quantity";
