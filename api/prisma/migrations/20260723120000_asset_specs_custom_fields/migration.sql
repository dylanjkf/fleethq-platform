-- Optional structured specs + free-form custom fields on assets. Additive:
-- every column is nullable so existing assets are untouched. No new RLS policy
-- needed — the assets table's existing tenant policies cover all columns.
ALTER TABLE "assets"
  ADD COLUMN "make" TEXT,
  ADD COLUMN "model" TEXT,
  ADD COLUMN "year" INTEGER,
  ADD COLUMN "vin" TEXT,
  ADD COLUMN "registration" TEXT,
  ADD COLUMN "odometer" INTEGER,
  ADD COLUMN "odometer_unit" TEXT,
  ADD COLUMN "custom_fields" JSONB;
