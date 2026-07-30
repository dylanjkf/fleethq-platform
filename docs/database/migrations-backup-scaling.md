# Migrations, backup/DR & scaling

Covers Part 15 (migrations), Part 16 (backup & disaster recovery), and Part 14
(large-scale readiness).

## Migrations (Part 15)

- **Version-controlled, forward-only.** Every schema change is a timestamped,
  hand-authored SQL migration under `apps/api/prisma/migrations/`, applied with
  `prisma migrate deploy`. `schema.prisma` is the source of truth; the migration
  SQL is written to match it (index names follow Prisma's convention, so
  `prisma validate` stays clean and there is no drift).
- **Additive and safe by default.** New columns are nullable or defaulted; new
  tables and indexes are additive; data backfills run inside the migration before
  a column is tightened. Destructive changes (dropping a column/table) are
  deliberately rare and staged (deprecate → stop writing → drop in a later
  release), never combined with the change that stops using them.
- **Tested in CI before merge.** `api-ci.yml` spins up a real Postgres, runs
  `prisma migrate deploy` from empty, runs the seed, and runs the full test suite
  — so a broken or out-of-order migration fails the build. `terraform-ci.yml`
  guards the infrastructure the database runs on.
- **Rollback strategy.** Because migrations are forward-only and additive, a bad
  *code* deploy rolls back to the previous container image without touching the
  schema (the additive migration is harmless to the old code). A bad *migration*
  (data-affecting) is recovered by RDS point-in-time restore to just before it
  ran — which is why data-affecting migrations are gated behind the manual,
  human-approved production deploy.

## Backup & disaster recovery (Part 16)

Full detail — including the tested-restore caveat — is in the security suite's
[backup-and-disaster-recovery.md](../security/cyber-essentials/backup-and-disaster-recovery.md).
In brief:

- **Automated backups + point-in-time recovery** on RDS (retention window +
  off-peak backup window), with a final snapshot on teardown and deletion
  protection in production.
- **Cross-region snapshot copy** (EventBridge + Lambda) so a regional loss does
  not lose data.
- **Backup encryption** via the same customer-managed KMS key as the volume.
- **S3 versioning** for attachment/site buckets (object-level recovery).
- **RPO ≈ 5 minutes** (PITR granularity) and **RTO in hours** (RDS restore + ECS
  redeploy) — design targets; a full timed restore drill on a production-sized
  dataset is the open validation item.

## Large-scale readiness (Part 14)

FleetOS runs on a single, vertically-scalable PostgreSQL instance today, which is
correct for the current stage. The scaling path is understood and staged so
complexity is added **only when a real signal demands it**, not pre-emptively.

### 10 companies (today)
Single `db.t4g.medium`-class instance, multi-AZ in production. **Connection
pooling** is already explicitly sized (app pool 15, auth pool 5 per task,
budgeted against `max_connections`) after load testing showed pool starvation,
not CPU, was the first limiter. No change needed.

### ~100 companies
- Right-size the instance vertically (more vCPU/RAM); add a **read replica** and
  route heavy read-only reporting/analytics queries to it (the reporting queries
  already run inside `withTenant` and are side-effect-free, so they move cleanly).
- Introduce a **caching layer** (e.g. Redis) for hot, tenant-scoped reference
  reads if profiling shows repeated identical queries.
- Stand up **data retention** for the append-only tables (below).

### ~10,000 companies
- **Table partitioning** on the highest-growth append-only tables — `gps_pings`
  first — by time range (and/or by `company_id` hash), so old breadcrumb
  partitions can be dropped/archived cheaply and queries prune to recent
  partitions. `timeline_events`, `audit_logs`, and `notifications` are the next
  candidates.
- **Archiving.** Move cold history (closed jobs, old pings, aged audit rows past
  their retention floor) to cheaper storage (partition detach → S3/Parquet),
  keeping the operational tables lean.
- **Tenant sharding** is the last resort. The RLS + `withTenant` design means the
  data is already cleanly partitionable by `company_id`, so a future move to
  per-shard databases (or Postgres logical sharding / a distributed Postgres such
  as Citus) is an evolution, not a rewrite — the application already never
  assumes cross-tenant queries.

### Data retention (needed before the highest tiers)
There is no automated purge today; the append-only tables grow unbounded. The
plan: define a per-table retention floor (e.g. GPS breadcrumbs 12–24 months,
notifications 12 months, audit logs per compliance policy), then run a scheduled,
leader-elected purge/archive job (the scheduler framework already exists). GPS
retention is also a **privacy** requirement (location history is personal
information) — see the secure-data-handling security doc.

> Guiding principle: none of the ~100 / ~10,000-company mechanisms are built yet,
> and deliberately so. They are documented as a ready plan to be pulled forward
> the moment load, cost, or a customer's scale makes one of them the bottleneck.
