# Database assessment — final report

The seven outputs requested by the database review, for the FleetOS PostgreSQL
database as of the accompanying hardening wave. This is a rigorous engineering
self-assessment, not an external audit.

## 1. Database architecture assessment

**Verdict: enterprise-grade foundation for its stage — not a prototype.**

FleetOS is a shared-database multi-tenant SaaS on PostgreSQL 16 with the
properties an enterprise buyer, a mining/logistics customer, or an auditor looks
for:

- **Database-enforced tenant isolation** via row-level security on every tenant
  table — not application `WHERE` clauses. Company A cannot read Company B's data
  even if the code forgets a filter.
- **Least-privilege role separation** (runtime RLS-subject role, narrow
  `BYPASSRLS` role, migration-only owner).
- **UUID primary keys** throughout (no enumerable IDs); **soft-delete-first**
  history (`archived_at`, no unsafe cascades); domain-appropriate timestamps.
- **Composite indexes on the hot paths**, verified with `EXPLAIN` against a
  12,000-row seeded dataset.
- **Encryption** in transit (incl. forced TLS to the DB) and at rest (KMS).
- **An append-only, RLS-scoped audit trail** and a per-entity business Timeline.
- **Version-controlled, forward-only, CI-tested migrations.**

It is genuinely close to Third Normal Form, with a few deliberate, documented
read-model/schemaless denormalisations. The design would extend cleanly to large
Australian logistics/transport/mining fleets.

**Overall database maturity: ~86/100** — a strong foundation whose remaining
distance is scale-headroom and governance, not structural rework.

## 2. Changes implemented (this wave)

- **GPS row-level security** — enabled + forced RLS with a `tenant_isolation`
  policy on `gps_devices`/`gps_pings` (the only tenant tables previously without
  it); routed the device-key ingest path through the `BYPASSRLS` role. e2e now
  proves isolation *at the database*. (`migrations/20260724130000_gps_rls`.)
- **Reverse-lookup foreign-key indexes** — added the FK indexes not already
  covered by a `company_id`-leading composite (memberships→role, assets→class,
  operators→fatigue-rule-set, part-usage→part, submissions→template,
  role→permission). (`migrations/20260724131500_fk_reverse_lookup_indexes` +
  `@@index` in the schema.)
- **This documentation suite** (`docs/database/`) — audit, ERD, security model,
  index strategy, migration/backup/scaling strategy, and this assessment.

*(Prior waves — E1–E3 — delivered the audit-log table, forced DB TLS, the
composite hot-path indexes, and the least-privilege roles this builds on.)*

## 3. Remaining risks

| Risk | Severity | Mitigation / plan |
|------|----------|-------------------|
| No automated retention/purge for high-growth append-only tables (`gps_pings`, `timeline_events`, `audit_logs`, `notifications`) — unbounded growth; GPS history is also a privacy concern. | High | Define per-table retention floors + a scheduled leader-elected purge/archive job (framework exists). |
| `push_subscriptions` is user-scoped with no RLS. | Medium | Add an explicit access-control test guaranteeing a subscription is only read for its own user. |
| No table partitioning on the highest-growth tables. | Medium (at scale) | Partition `gps_pings` by time when volume warrants — see scaling doc. |
| `updated_at` maintained at the app layer only (no DB trigger). | Low | Add a `BEFORE UPDATE` trigger if out-of-ORM writes ever occur. |
| No formal data classification; JSONB validated only at the DTO layer. | Low | Introduce a lightweight classification scheme; acceptable as-is. |
| Full restore drill not yet performed at production scale. | Medium | Run a timed PITR restore drill and record actual RPO/RTO. |

## 4. Scalability assessment

**Ready for 10 → ~100 companies today with vertical scaling + a read replica; the
path to ~10,000 is understood and staged.** Connection pooling is already sized
from load testing. The RLS + `withTenant` design means the data is cleanly
partitionable by `company_id`, so read replicas, table partitioning, archiving,
and (last resort) tenant sharding are evolutions rather than rewrites. The
binding pre-requisite for the highest tiers is **data retention/partitioning on
the append-only tables** — everything else is capacity, not redesign. Detail in
[migrations-backup-scaling.md](./migrations-backup-scaling.md).

## 5. ISO/IEC 27001:2022 — database alignment

**~66/100.** The Annex A *technical* controls that live in the data layer are
strong; the governance wrapper is the gap.

- **Strong:** A.5.15 / A.8.3 (access control — RLS + least-privilege roles),
  A.8.2 (privileged access — the owner/auth roles are narrow and separated),
  A.8.24 (cryptography — at rest + in transit), A.8.15 (logging — append-only
  audit trail), A.8.13 (backup), A.8.9 (configuration — IaC + fail-fast env
  validation).
- **Partial / gap:** A.8.10 (information deletion — Privacy-Act redaction exists,
  but no retention schedule and S3-version erasure completeness is open), A.5.12
  (data classification — not implemented), A.8.11 (data masking — none beyond
  hashing).

## 6. SOC 2 (2017 TSC) — database alignment

**~65/100.**

- **CC6 (logical & physical access):** strong — RLS tenant isolation, role
  separation, encrypted credentials from Secrets Manager, UUID keys. The
  database's strongest criterion.
- **CC7 (system operations / monitoring):** the append-only audit trail is in
  place; the gap is *alerting* on database security signals (covered in the
  security suite's monitoring doc) and audit-log retention policy.
- **CC8 (change management):** versioned, CI-tested, human-approved migrations —
  well supported.
- **A1 (availability):** automated backups, cross-region snapshot copy, and
  multi-AZ are implemented; A1.3 (recovery *testing*) is the open item.

As with the app-wide assessment, formal policies and a SOC 2 observation period
are organisational work outstanding, not database structure.

## 7. Recommended future improvements

**Near term (highest value):**
1. **Data retention & purge** for `gps_pings` / `timeline_events` / `audit_logs`
   / `notifications` — closes the top scale and privacy risk.
2. **`push_subscriptions` access-control test** (and consider a user-scoped RLS
   policy).
3. **Restore drill** — validate RPO/RTO on a production-sized dataset.

**Medium term:**
4. **Read replica** + route reporting/analytics reads to it.
5. **Partition `gps_pings`** by time (prep for the ~10,000-company tier).
6. **`BEFORE UPDATE` trigger** for authoritative `updated_at`.

**Longer term (only if justified):**
7. **Normalised vehicle make/model/manufacturer catalogue** if cross-fleet
   reporting or data-quality needs arise (avoid premature over-normalisation).
8. **Column-level PII encryption** beyond volume-level KMS, if a customer/contract
   requires field-level cryptographic separation.
9. **Data classification scheme** driving masking, logging, and retention rules —
   the connective tissue for ISO 27001 / SOC 2 maturity.
