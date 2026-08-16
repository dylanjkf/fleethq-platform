-- Per-asset price change: $19.00 -> $9.00 (1900 -> 900 integer cents).
--
-- The price lives in the single-row billing_settings table (the display/quote
-- source of truth read by the signup page, billing page and quotes). The actual
-- charge is the Stripe Price object pointed at by STRIPE_PRICE_PER_ASSET, which
-- must be (re)created at $9 in Stripe as an ops step — this migration only moves
-- the app-side figure.

-- 1) New installs default to $9.
ALTER TABLE "billing_settings" ALTER COLUMN "price_per_asset_cents" SET DEFAULT 900;

-- 2) Move the live singleton to $9, but ONLY if it is still the previous launch
--    default (1900). If an operator deliberately set some other price, leave it
--    untouched rather than clobbering an intentional value.
UPDATE "billing_settings"
   SET "price_per_asset_cents" = 900,
       "updated_at" = NOW()
 WHERE "id" = 1
   AND "price_per_asset_cents" = 1900;
