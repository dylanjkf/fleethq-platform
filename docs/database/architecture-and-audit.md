# Database audit, design principles & normalisation

## Part 1 — Current-state audit

This is an honest engineering audit of the FleetOS database against
enterprise-SaaS expectations, done by reading the schema, the migration history,
and the live catalog (RLS status, indexes, foreign keys). The headline: the
foundation is **strong** — database-enforced tenant isolation, least-privilege
roles, UUID keys, versioned migrations, and composite indexes on the hot paths.
The findings below are the real remaining items, ranked by severity. Items marked
**(fixed)** were closed in the database-hardening wave that accompanies this
document.

### Critical
*None open.* The one issue that approached critical — the GPS tables being the
only tenant tables without row-level security — is now closed (below).

### High
- **GPS tables lacked row-level security — (fixed).** `gps_devices` and
  `gps_pings` carried `company_id` but were the only tenant tables not protected
  by RLS; isolation rested solely on the service-layer `companyId` filter. RLS is
  now enabled + forced on both, with the device-key ingest path routed through
  the `BYPASSRLS` role. A forgotten filter can no longer leak one company's
  device/position data. (`migrations/20260724130000_gps_rls`.)
- **No formal data-retention / purge for high-growth append-only tables.**
  `gps_pings` (GPS breadcrumbs), `timeline_events`, `audit_logs`, and
  `notifications` grow unbounded. This is a scale and (for location history) a
  privacy concern. There is no automated purge/archival today. See
  [migrations-backup-scaling.md](./migrations-backup-scaling.md) for the plan.

### Medium
- **Reverse-lookup foreign keys were unindexed — (mostly fixed).** Most
  tenant-scoped FK lookups are already served by the Wave-A composites leading
  with `company_id`; the genuinely-unindexed *reverse* lookups (e.g. "how many
  memberships use this role?", "which assets are in this class?") are now indexed.
  A few pure actor-attribution FKs remain intentionally unindexed (low value —
  see [indexing-and-performance.md](./indexing-and-performance.md)).
- **`push_subscriptions` is user-scoped, not company-scoped, and has no RLS.** A
  Web-Push subscription belongs to a *user* (who may belong to several
  companies), so company-scoping does not cleanly apply; access is filtered by
  `user_id`. This is defensible but should be covered by an explicit
  access-control test to guarantee a subscription is only ever read for its own
  user.
- **No database-level `updated_at` trigger.** `updated_at` is maintained by
  Prisma's `@updatedAt` at the application layer; a raw `UPDATE` outside Prisma
  (e.g. an ad-hoc admin fix) would not bump it. Acceptable given all writes go
  through the ORM, but a `BEFORE UPDATE` trigger would make it authoritative.

### Low
- **No `created_by`/`updated_by` columns on most tables — by design.** Actor
  attribution is provided by two dedicated mechanisms rather than per-row
  columns: the per-entity **Timeline** (`timeline_events`, business history with
  `actor_user_id`) and the **audit log** (`audit_logs`, security events). Adding
  `created_by`/`updated_by` everywhere would duplicate the Timeline the product
  is built around. Documented as a deliberate choice, not an omission.
- **JSONB columns are validated at the DTO layer, not by the database.** Dynamic
  forms, checklist answers, asset custom fields, and audit metadata use `Json`
  columns; their shape is enforced by class-validator DTOs, not DB `CHECK`
  constraints. Standard and acceptable for schemaless-by-design data.
- **Free-text vehicle make/model (denormalised).** See Part 4.

## Part 3 — Core design principles

The schema already follows enterprise conventions consistently:

- **UUID primary keys everywhere** (`@db.Uuid`, `gen_random_uuid()`), across all
  51 models — no sequential integer IDs that would leak record counts or allow
  resource-guessing. 144 UUID-typed columns in total.
- **Timestamps.** `created_at` on every substantive entity (43 models);
  `updated_at` (`@updatedAt`) on the 31 mutable ones. Append-only tables
  (`audit_logs`, `gps_pings`, `timeline_events`) correctly omit `updated_at`;
  tables with domain-specific time columns (`operator_shifts.started_at`,
  `gps_pings.recorded_at`) use those.
- **Soft deletes.** `archived_at` on the 30+ entities that must retain history
  (assets, operators, jobs, roles, devices, …). The product deletes almost
  nothing — it archives — which is why there are **no `ON DELETE CASCADE` rules**:
  foreign keys default to `RESTRICT`/`SET NULL`, so a hard delete can never
  silently orphan or destroy referenced history. Hard erasure is reserved for the
  Privacy-Act path, which redacts fields rather than dropping rows.
- **Actor attribution** via Timeline + audit log (above).

## Part 4 — Normalisation

The schema targets **Third Normal Form** and largely achieves it: reference data
is factored out (`asset_classes`, `permissions`, `fatigue_rule_sets`,
`checklist_templates`, `maintenance_schedule_templates`), join tables model
many-to-many relationships (`role_permissions`, `checklist_bundle_items`), and
there is no repeating-group duplication of tenant data.

Deliberate, documented deviations (pragmatism over dogma):

- **Cached last-known position.** `operators.last_lat/last_lng/last_location_at`
  and `gps_devices.last_lat/last_lng` duplicate the most-recent `gps_pings` row.
  This is an intentional read-model denormalisation: the live map needs the
  current position of every unit in one cheap query, without a
  latest-row-per-device correlated subquery over a multi-million-row breadcrumb
  table. The `gps_pings` history remains the source of truth.
- **JSONB for schemaless-by-design data.** Dynamic form definitions/answers,
  asset custom fields, and audit metadata are `Json`, not further-normalised
  tables — because their shape is defined *by the tenant at runtime*, so a fixed
  relational schema would be wrong.
- **Free-text vehicle make/model.** Assets store `make`/`model` as strings (with
  an Australian-vehicle quick-fill helper) rather than normalised
  `manufacturers`/`vehicle_models` tables. This trades cross-fleet make/model
  consistency for simplicity and is appropriate at the current scale; a future
  normalised catalogue is noted as an option in
  [assessment.md](./assessment.md), to be introduced only if reporting or
  data-quality needs justify it (avoiding premature over-normalisation).

Nothing is under-normalised in a way that risks update anomalies on tenant data;
the deviations are all read-model or schemaless-by-design choices with a clear
rationale.
