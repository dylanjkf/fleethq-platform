# Indexing & performance

Covers Part 13. The indexing strategy is driven by how the application actually
queries — every tenant query is company-scoped through RLS — rather than by
blanket-indexing every column.

## Philosophy

1. **Lead composite indexes with `company_id`.** Because RLS appends
   `company_id = <current tenant>` to every tenant query, the most useful index
   for a filtered/sorted list is `(company_id, <filter-or-sort-col>)`. These
   serve the hot paths: per-asset history, per-operator jobs, per-recipient
   notifications, dispatch date ranges, etc.
2. **Index the reverse lookups a composite doesn't cover.** "Which rows reference
   this parent?" (role-in-use, class-in-use, template usage) is not served by a
   `company_id`-leading composite, so those foreign keys get their own index —
   which also speeds the referential-integrity check Postgres runs on parent
   changes. (Added in DB Wave 1.)
3. **Partial indexes for sparse hot predicates.** Where a query always filters on
   a boolean/nullable state, the index is partial so it stays small and is only
   touched when relevant.
4. **Avoid over-indexing.** Pure actor-attribution foreign keys
   (`uploaded_by_user_id`, `author_user_id`, …) are intentionally left unindexed:
   they are rarely queried by that column, and their parents are soft-deleted
   (so there is no cascade-scan pressure). Every index is a write cost.

## Index catalogue (representative)

The schema declares 68 indexes via `@@index`/`@@unique`/`@@id`. Highlights:

**Tenant hot-path composites (Wave A + core):**
- `jobs (company_id, asset_id)`, `(company_id, operator_id)`, `(company_id, scheduled_at)`
- `job_stops (company_id, job_id)`, `(company_id, customer_id)`, `(company_id, completed_at)`
- `maintenance_jobs (company_id, asset_id)`
- `compliance_documents (company_id, asset_id)`, `(company_id, operator_id)`
- `checklist_submissions (company_id, asset_id)`, `(company_id, submitted_at)`
- `messages (company_id, operator_id, created_at)`
- `notifications (company_id, recipient_user_id, created_at)`, `(company_id, recipient_user_id, read_at)`
- `gps_pings (company_id, device_id)`

**Partial indexes (sparse hot predicates):**
- `compliance_documents (company_id, expires_at) WHERE archived_at IS NULL` — the expiry sweep.
- `notifications (company_id, created_at) WHERE emailed_at IS NULL AND read_at IS NULL` — the digest queue.
- Partial *unique* indexes enforcing one ACTIVE shift per operator, and unique VIN/registration per company among live rows.

**Reverse-lookup indexes (DB Wave 1):**
- `company_memberships (company_id, role_id)` — role-archive guard.
- `assets (company_id, asset_class_id)` — class filtering / class-in-use guard.
- `operators (company_id, fatigue_rule_set_id)` — rule-set usage + fatigue joins.
- `maintenance_job_part_usages (company_id, part_id)` — part-in-use guard.
- `checklist_submissions (company_id, template_id)` — template usage.
- `role_permissions (permission_id)` — "which roles grant this permission?"

**Uniqueness constraints** back key invariants: `company_memberships (user_id,
company_id)`, `users.username`, `gps_devices.device_key_hash`, per-company VIN and
registration.

## Pagination

List endpoints are server-paginated (`skip`/`take` with a hard cap) via a shared
`ListQueryDto`, with server-side multi-column search pushed into SQL — so a
tenant with millions of rows is never fully materialised into the API or the
browser. Reports aggregate in SQL (`count(*) FILTER`, `date_trunc` buckets)
rather than pulling rows into Node.

## Verification, not assumption

Index usage is asserted, not assumed: `test/scale-performance.e2e-spec.ts` seeds
one tenant with **12,000 delivery stops** and uses `EXPLAIN` to prove the impact
report hits `job_stops_company_id_completed_at_idx` (no `Seq Scan`) and returns
in under budget. New hot paths should be added to that harness.

## Growth watch

The append-only tables — `gps_pings`, `timeline_events`, `audit_logs`,
`notifications` — are the ones that grow without bound. Their read paths are
indexed, but their *size* is the scaling concern addressed by retention and
partitioning in [migrations-backup-scaling.md](./migrations-backup-scaling.md).
