-- FleetHQ Internal Administration Platform — Phase 5a: support tools
-- (21-Admin-Platform/Overview.md). Two new tables: `admin_organisation_notes`
-- (staff-internal, never readable by the customer stack) and `announcements`
-- (a staff-authored banner deliberately readable by the customer stack — see
-- the model's own doc comment in schema.prisma).
--
-- Note: only the tables/enum/indexes/foreign-keys/grants this phase actually
-- adds are included below. `prisma migrate dev`'s auto-generated diff also
-- proposed dropping and re-adding several unrelated foreign keys and column
-- defaults on pre-existing tables — that's schema drift local to this
-- sandbox's dev database (not present against a cleanly-migrated database),
-- not a real change this migration should make, so it's deliberately
-- excluded here, same as the admin_platform_foundation migration before it.

-- CreateEnum
CREATE TYPE "AnnouncementSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "admin_organisation_notes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "admin_user_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_organisation_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" "AnnouncementSeverity" NOT NULL DEFAULT 'INFO',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "created_by_admin_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_organisation_notes_company_id_created_at_idx" ON "admin_organisation_notes"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "announcements_active_starts_at_ends_at_idx" ON "announcements"("active", "starts_at", "ends_at");

-- AddForeignKey
ALTER TABLE "admin_organisation_notes" ADD CONSTRAINT "admin_organisation_notes_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_admin_user_id_fkey" FOREIGN KEY ("created_by_admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- fleetos_admin: full CRUD (including DELETE, unlike the core tenant tables
-- it touches) on both new tables — these are ancillary staff-authored
-- content (support notes, banners), not customer business/audit records, so
-- letting an admin delete a mistaken note or an expired announcement doesn't
-- weaken the "no hard deletes of tenant data" posture that applies to
-- `companies`/`users`/etc.
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_organisation_notes TO fleetos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON announcements TO fleetos_admin;

-- fleetos_app: read-only on announcements ONLY — every company sees the same
-- rows (no tenant data here to leak), so a plain GRANT with no RLS policy is
-- sufficient and correct. admin_organisation_notes gets no fleetos_app grant
-- at all: it must never be reachable from the customer stack.
GRANT SELECT ON announcements TO fleetos_app;
