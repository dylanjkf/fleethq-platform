-- Reverse-lookup / referential-integrity indexes on foreign keys that no
-- existing composite already covers.
--
-- Most tenant-scoped FK lookups are already served by the Wave A composites
-- leading with company_id (e.g. jobs(company_id, asset_id)); this migration
-- only adds indexes for the *reverse* lookups and integrity checks that were
-- genuinely unindexed — "which rows reference this parent?" — which otherwise
-- force a sequential scan (and slow the referential-integrity check Postgres
-- runs when a referenced parent row is updated or deleted). Kept deliberately
-- narrow to avoid the write-amplification and storage cost of over-indexing.
--
-- IF NOT EXISTS so this is safe to re-run. On a very large production table,
-- prefer creating the equivalent index CONCURRENTLY out-of-band first; these
-- names match Prisma's convention so the schema stays the source of truth.

-- "How many memberships use this role?" — the role-archive guard counts these.
CREATE INDEX IF NOT EXISTS "company_memberships_company_id_role_id_idx" ON "company_memberships" ("company_id", "role_id");

-- "Which roles grant this permission?" — the PK covers (role_id, permission_id)
-- leading with role_id; this covers the permission_id-leading reverse lookup.
CREATE INDEX IF NOT EXISTS "role_permissions_permission_id_idx" ON "role_permissions" ("permission_id");

-- "Which assets are in this class?" (+ the class-in-use guard on archive).
CREATE INDEX IF NOT EXISTS "assets_company_id_asset_class_id_idx" ON "assets" ("company_id", "asset_class_id");

-- "Which operators use this fatigue rule set?" (+ fatigue evaluation joins).
CREATE INDEX IF NOT EXISTS "operators_company_id_fatigue_rule_set_id_idx" ON "operators" ("company_id", "fatigue_rule_set_id");

-- "Where has this part been used?" (+ the part-archive guard).
CREATE INDEX IF NOT EXISTS "maintenance_job_part_usages_company_id_part_id_idx" ON "maintenance_job_part_usages" ("company_id", "part_id");

-- "Which submissions used this checklist template?"
CREATE INDEX IF NOT EXISTS "checklist_submissions_company_id_template_id_idx" ON "checklist_submissions" ("company_id", "template_id");
