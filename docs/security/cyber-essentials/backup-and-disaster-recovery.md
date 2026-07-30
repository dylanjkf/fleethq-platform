# Backup & disaster recovery

## Intent

FleetOS is a system of record for compliance and delivery evidence, so the
platform must be able to recover customer data after corruption, accidental
deletion, a failed deploy, or a regional outage — with a known, bounded amount of
data loss and downtime. This is the backup & DR plan; recovery targets stated
here are design targets and are noted where they have not yet been proven in a
drill.

## What is backed up

- **Primary database (RDS PostgreSQL).** Automated backups are enabled with
  point-in-time recovery — `backup_retention_period = var.backup_retention_days`,
  in a fixed off-peak `backup_window` (14:00–15:00 UTC), with
  `copy_tags_to_snapshot` and `skip_final_snapshot = false` (a final snapshot is
  taken on destroy). `infra/terraform/modules/database/main.tf`.
- **Cross-region snapshot copy (DR defence in depth).** An EventBridge + Lambda
  pair copies the latest automated snapshot to a second AWS region, so a
  region-level loss of the primary does not lose the data.
  `infra/terraform/modules/database/main.tf` (`snapshot_copy` Lambda + schedule).
- **Attachment & site storage (S3).** The attachment and static-site buckets are
  **versioned** and SSE-KMS encrypted with a full public-access block, so an
  object overwrite or delete is recoverable from a prior version.
  `infra/terraform/modules/api-service/main.tf`,
  `infra/terraform/modules/frontend/main.tf`.
- **Infrastructure definition.** The entire production topology is
  infrastructure-as-code under `infra/terraform`, in git — the environment itself
  can be rebuilt from source. Application images are retained in ECR by tag
  (`github.sha`).
- **Deletion protection.** `deletion_protection = var.deletion_protection`
  (enabled in production) prevents accidental teardown of the database instance.

## Recovery targets

| Metric | Target | Basis / caveat |
|--------|--------|----------------|
| **RPO** (max data loss) | ≈ 5 minutes | RDS point-in-time recovery replays to a chosen second within the retention window. Design target — not yet validated under production transaction volume. |
| **RTO** (max downtime) | Hours (single region) | Bounded by RDS restore + ECS redeploy time; a cross-region rebuild is longer. Design target — see the untested-drill caveat below. |

## Restore procedures

### Data corruption / accidental deletion (same region)
Restore the RDS instance to a point in time just before the event (RDS
point-in-time restore), repoint the API to the restored endpoint, and verify
integrity. For an individual object, restore the prior S3 version.

### Failed deploy
Deploys are manual (`workflow_dispatch`) and the ECS deployment circuit breaker
rolls back automatically on a failed stabilisation; migrations are forward-only,
so a bad *code* deploy rolls back to the prior task definition without a data
restore. A bad *migration* is recovered by point-in-time restore to just before it.

### Regional outage (DR)
Rebuild in the secondary region from the cross-region snapshot copy plus the
Terraform definition and the ECR image, then cut DNS over. This is the
longest-RTO path and is the least-exercised.

## Environment posture

Per-environment tfvars set the resilience level: production runs multi-AZ
(`var.multi_az`) with deletion protection and a longer backup retention; staging
is deliberately smaller/single-AZ with deletion protection off. Each environment
has isolated remote state. `infra/terraform/environments/base`.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **Restore has not been drilled at scale.** The backup and cross-region copy are configured, but a full timed restore (proving the RPO/RTO targets on a production-sized dataset) has not been performed. | medium | Run a scheduled restore drill into an isolated environment, measure actual RPO/RTO, and record the results. |
| No documented, signed business-continuity / DR runbook ownership. | medium | Assign DR ownership and fold this document into a maintained runbook with named roles. |
| S3 versioning aids recovery but interacts with secure erasure — a prior version of an "erased" object can persist. | low | Reconcile with the erasure-completeness work in [10-secure-data-handling.md](./10-secure-data-handling.md). |

## Standards mapping

**Cyber Essentials:** operational resilience (supports secure configuration &
recovery expectations).

**ISO/IEC 27001:2022 Annex A:** A.8.13 (information backup) — met in configuration;
A.5.29 (security during disruption) and A.5.30 (ICT readiness for business
continuity) — partially met, gated on a tested DR runbook; A.8.14 (redundancy) —
multi-AZ + cross-region snapshot copy in place.

**SOC 2 (2017 TSC):** Availability criteria A1.2 (backup/recovery) and A1.3
(recovery testing). Backups and redundancy are implemented; A1.3 specifically
requires *testing* recovery, which is the open item.
