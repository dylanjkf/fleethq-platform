-- Give AttachedUnit the same optional structured specs an Asset already has, so
-- a unit's detail view has real content instead of just a name.
--
-- A trailer/dolly has a registration, VIN, make and build year exactly like a
-- prime mover does; the fields were simply never modelled. Mirrors the Asset
-- columns (same names, same nullability, same free-form `custom_fields` escape
-- hatch) rather than inventing a parallel vocabulary — one concept, one shape.
-- Every column is nullable: a company that only wants a name keeps working.

ALTER TABLE "attached_units"
  ADD COLUMN "make"          TEXT,
  ADD COLUMN "model"         TEXT,
  ADD COLUMN "year"          INTEGER,
  ADD COLUMN "vin"           TEXT,
  ADD COLUMN "registration"  TEXT,
  ADD COLUMN "notes"         TEXT,
  ADD COLUMN "custom_fields" JSONB;
