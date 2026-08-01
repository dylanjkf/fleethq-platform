# Backup & disaster recovery

## Intent

FleetOS is a system of record for compliance and delivery evidence, so the
platform must be able to recover customer data after corruption, accidental
deletion, a failed deploy, or a regional outage — with a known, bounded amount of
data loss and downtime. This is the backup & DR plan; recovery targets stated
here are design targets and are noted where they have not yet been proven in a
drill.

> **Status of this domain.** What is **implemented in this repository today** is a
> **dump/restore drill script** (`api/scripts/restore-drill.sh`) and a
> **scheduled CI workflow** (`.github/workflows/restore-drill.yml`) that runs it
> weekly against a freshly-migrated, seeded database, so a schema/restore
> regression fails a scheduled run. The **managed-database backup topology** —
> RDS point-in-time recovery, cross-region snapshot copy, multi-AZ — is a
> **⏳ Planned target architecture**: there is no Terraform or other IaC in this
> repository, and **production RPO/RTO have not been proven against a live managed
> database.** In the current deployment path the primary database is **Railway
> Postgres**, whose managed backups are a platform feature, not a control defined
> in this repo.

## What is implemented today

- **A dump/restore drill script.** `api/scripts/restore-drill.sh` dumps the
  database, restores that dump into a throwaway scratch database, and verifies the
  restored copy matches the source row-for-row on the key tables (companies,
  users, operators, assets, jobs, job_stops, attachments, compliance_documents,
  timeline_events). It leaves the source untouched and drops the scratch database
  afterwards. This proves the dump *round-trips* — the failure mode where a
  migration produces something `pg_dump`/`pg_restore` cannot faithfully rebuild.
- **A scheduled drill in CI.** `.github/workflows/restore-drill.yml` runs the
  script every Monday (03:00 UTC) and on demand (`workflow_dispatch`): it stands
  up a `postgres:16` service, applies all migrations, seeds a representative
  dataset, and runs the drill — so schema/restore drift fails the scheduled run
  instead of surfacing during a real recovery. This replaces the previous
  "manual weekly reminder" and is the *automated* half of the recovery-testing
  control.
- **Application images / config are in git.** The API is rebuilt from source on
  every Railway deploy (`api/railway.json` → Dockerfile builder); there is no
  server state to back up beyond the database and any configured attachment
  storage.

## ⏳ Target architecture (planned — NOT yet implemented)

The following describes the intended managed-database backup posture. **None of it
is built or defined in this repository** (no `infra/terraform`, no `.tf`); treat
each as Planned.

- **Primary database point-in-time recovery.** Automated backups with PITR on the
  managed Postgres, a fixed off-peak backup window, and a retained final snapshot
  on teardown.
- **Cross-region snapshot copy (DR defence in depth).** The latest automated
  snapshot copied to a second region so a region-level loss does not lose data.
- **Attachment & site storage (S3).** Versioned, SSE-KMS-encrypted buckets with a
  public-access block, so an object overwrite or delete is recoverable from a
  prior version. (Only relevant once `ATTACHMENTS_BUCKET` is configured; the
  default is inline-in-Postgres.)
- **Multi-AZ + deletion protection.** A synchronous standby and accidental-teardown
  protection in production.

## Recovery targets

| Metric | Target | Basis / caveat |
|--------|--------|----------------|
| **RPO** (max data loss) | ≈ 5 minutes | Assumes managed-database point-in-time recovery within a retention window. **Planned/target — not yet built and not validated.** Current Railway backups' effective RPO is the platform's snapshot cadence, not a repo-defined control. |
| **RTO** (max downtime) | Hours (single region) | Assumes managed restore + redeploy time. **Planned/target — not yet proven in a drill against a live database.** |

## Restore procedures

### Schema/restore-round-trip regression (proven in CI today)
The scheduled `restore-drill.yml` dumps and restores a freshly-migrated, seeded
database and asserts row-count parity, so a migration that breaks the dump/restore
round-trip fails the weekly run. This is the one recovery property currently
exercised automatically.

### Data corruption / accidental deletion (managed database — planned)
Restore the database to a point in time just before the event using the managed
provider's PITR (Railway, or RDS in the target architecture), repoint the API to
the restored endpoint, and verify integrity. For an individual attachment object,
restore the prior version (requires versioned S3 — target architecture).

### Failed deploy
Railway keeps the previous deploy and can roll back to it; migrations are
forward-only (run automatically by `api/docker-entrypoint.sh` on deploy), so a bad
*code* deploy rolls back to the prior image without a data restore. A bad
*migration* is recovered by a point-in-time restore to just before it — which is
why the schema round-trip is drilled in CI.

### Regional outage (DR — planned)
Rebuild in a secondary region from the cross-region snapshot copy plus the (future)
IaC definition and the container image, then cut DNS over. This is the longest-RTO
path and is entirely target architecture today.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **Production RPO/RTO are not proven against a live managed database.** The CI drill proves the dump/restore *script* round-trips a seeded database; it does **not** measure recovery of a production-sized dataset or validate the managed provider's PITR. | high | Run a timed restore against the real (Railway/AWS) database, measure actual RPO/RTO, and record the results. This needs the live environment. |
| **The managed-database backup topology is not defined as code.** PITR, cross-region copy, and multi-AZ are target architecture with no `infra/terraform` behind them; today's backups are whatever Railway provides by default. | high | Author the IaC (or document and accept the Railway-native backup settings explicitly as the production posture). |
| No documented, signed business-continuity / DR runbook ownership. | medium | Assign DR ownership and fold this document into a maintained runbook with named roles. |
| S3 versioning (once configured) aids recovery but interacts with secure erasure — a prior version of an "erased" object can persist. | low | Reconcile with the erasure-completeness work in [10-secure-data-handling.md](./10-secure-data-handling.md). |

## Standards mapping

**Cyber Essentials:** operational resilience. A scheduled dump/restore drill is a
real continuous-assurance control; the managed-database backup topology is planned.

**ISO/IEC 27001:2022 Annex A:** A.8.13 (information backup) — *partial*: a
dump/restore path is drilled in CI, but the managed-database backup topology is
planned; A.5.29 / A.5.30 (security during disruption / ICT readiness for business
continuity) — *partial*, gated on a proven DR runbook against a live database;
A.8.14 (redundancy) — *planned* (multi-AZ + cross-region are target architecture).

**SOC 2 (2017 TSC):** Availability A1.2 (backup/recovery) — *partial*; A1.3
(recovery **testing**) — the scheduled `restore-drill.yml` provides an automated,
scheduled test of the dump/restore script, but testing recovery of a
production-sized live database remains the open item.
