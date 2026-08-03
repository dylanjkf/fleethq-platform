# FleetOS Database Architecture

This directory documents the FleetOS database — its design, tenant-isolation
model, indexing, security, migration practice, and scaling path — for engineers,
enterprise buyers, and auditors. Every claim is grounded in the schema
(`apps/api/prisma/schema.prisma`), the migration history
(`apps/api/prisma/migrations/`), or the running database catalog.

## The system in one paragraph

FleetOS is a multi-tenant B2B SaaS on **PostgreSQL 16**, accessed through
**Prisma 5** from a NestJS API. It is a single database shared by all tenant
companies, with isolation enforced by **PostgreSQL row-level security (RLS)** —
not by application `WHERE` clauses. As of the current schema there are **49
models / tables**, **UUID primary keys** throughout, soft deletes (`archived_at`)
on the entities that need history, and **53 version-controlled migrations**.

## The two foundations

1. **RLS multi-tenancy.** The application connects as a low-privilege database
   role (`fleetos_app`) that is *subject to* row-level security. Every
   tenant-scoped query runs inside `prisma.withTenant(companyId, tx => …)`, which
   sets a per-transaction `app.current_company_id` GUC; each tenant table's
   `tenant_isolation` policy restricts every row it returns or writes to that
   company. A user from Company A cannot read Company B's rows even if the
   application code forgets a filter — the database refuses. See
   [security-model.md](./security-model.md).
2. **Least-privilege database roles.** Three roles, by blast radius:
   `fleetos_app` (runtime, RLS-subject, no DDL), `fleetos_auth` (a narrow
   `BYPASSRLS` role for the handful of pre-tenant operations — login lookups,
   system audit writes, device-key GPS ingest), and the **schema owner** (used
   only by migrations, never by the serving process).

## Document index

| Document | Covers |
|----------|--------|
| [architecture-and-audit.md](./architecture-and-audit.md) | Current-state audit (Critical→Low), core design principles, normalisation |
| [entity-relationship-model.md](./entity-relationship-model.md) | ERD, entity groups, relationship catalogue with cardinality & rationale |
| [security-model.md](./security-model.md) | Tenant isolation, RLS policies, DB roles, encryption, injection defence |
| [indexing-and-performance.md](./indexing-and-performance.md) | Index philosophy, the index catalogue, pagination, query patterns |
| [migrations-backup-scaling.md](./migrations-backup-scaling.md) | Migration practice, backup/DR (RPO/RTO), and the 10→10,000-company scaling path |
| [assessment.md](./assessment.md) | **Final assessment** — changes made, residual risks, scalability, ISO 27001 / SOC 2 alignment, roadmap |

## Headline assessment

The database foundation is **enterprise-grade for its stage**: database-enforced
tenant isolation, least-privilege roles, UUID keys, versioned migrations,
composite indexes on the hot paths, encryption in transit (TLS) plus
application-level at-rest encryption of stored secrets (integration
credentials, AES-256-GCM), and an append-only audit trail. Full
database/disk-level at-rest encryption depends on the managed host's defaults
rather than a repo-defined control (see `../compliance/readiness.md`). The recent database hardening closed the **one
tenant-isolation gap** (the GPS tables were the only tenant tables without RLS)
and added the missing reverse-lookup indexes.

What remains is scale-readiness *headroom* (table partitioning and read replicas,
not yet needed) and governance (a formal data-retention schedule). Full detail,
scores, and the roadmap are in [assessment.md](./assessment.md).

> Source-of-truth note: where this documentation and the schema disagree, the
> **schema is correct** and the doc is stale — please open a fix.
