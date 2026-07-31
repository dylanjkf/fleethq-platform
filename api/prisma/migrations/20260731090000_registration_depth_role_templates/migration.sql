-- Auth/Billing Platform Phase 4: registration depth (org intake fields on
-- Company) + named role templates (no schema change for the latter — it's
-- just data provisionCompany/reconcile-permissions.ts create, using the
-- existing roles/role_permissions tables).
--
-- Hand-written (not `prisma migrate dev`'s raw diff), same reasoning as the
-- Phase 1-3 migrations: avoids pulling in unrelated pre-existing schema
-- drift on other tables that a full shadow-DB diff picks up.
--
-- "companies" already has a blanket `GRANT SELECT, INSERT, UPDATE ON
-- companies TO fleetos_app` from the row_level_security migration (not the
-- users-table-style column-level grants fleetos_auth needs) — these new
-- nullable columns need no additional grant.
ALTER TABLE "companies" ADD COLUMN "abn" TEXT;
ALTER TABLE "companies" ADD COLUMN "industry" TEXT;
ALTER TABLE "companies" ADD COLUMN "phone" TEXT;
ALTER TABLE "companies" ADD COLUMN "fleet_size_estimate" INTEGER;
ALTER TABLE "companies" ADD COLUMN "terms_accepted_at" TIMESTAMP(3);
