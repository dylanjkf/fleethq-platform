# FleetOS Security — Cyber Essentials-style control set

This directory is FleetOS's **evidence-based security control documentation**,
organised around the technical control themes of the UK Cyber Essentials scheme
and mapped forward to ISO/IEC 27001:2022 Annex A and the SOC 2 (2017 TSC)
Common Criteria. It is written to be read by an enterprise buyer's security
team, a prospective auditor, or a new engineer — every control claim points at
the code, migration, or infrastructure file that implements it.

> **What this is.** A record of the technical controls that are *actually built
> into the product*, with file-level evidence, plus an honest register of the
> gaps that remain and the plan to close them.
>
> **What this is not.** A certification. FleetOS has not (yet) completed a
> Cyber Essentials assessment, an ISO 27001 audit, or a SOC 2 examination, and
> no independent penetration test has been performed. Where a control is
> organisational (a signed policy, a management review, an audit observation
> period) rather than technical, that is called out as such.

## How to read this

Each domain document has the same shape:

- **Intent** — what the control theme is trying to achieve.
- **What's implemented** — the controls in place, each with a `path:line`-style
  evidence pointer into this repository.
- **Gaps & residual risk** — what is missing or accepted, with severity.
- **Standards mapping** — the Cyber Essentials theme, ISO 27001 Annex A
  control(s), and SOC 2 criteria the domain speaks to.

## Control domains

| # | Domain | Doc |
|---|--------|-----|
| 1 | Secure network architecture | [01-secure-network-architecture.md](./01-secure-network-architecture.md) |
| 2 | Secure configuration | [02-secure-configuration.md](./02-secure-configuration.md) |
| 3 | Access control & user management | [03-access-control.md](./03-access-control.md) |
| 4 | Patch & vulnerability management | [04-patch-and-vulnerability-management.md](./04-patch-and-vulnerability-management.md) |
| 5 | Malware protection & file uploads | [05-malware-and-file-upload-protection.md](./05-malware-and-file-upload-protection.md) |
| 6 | Secure development lifecycle | [06-secure-development-lifecycle.md](./06-secure-development-lifecycle.md) |
| 7 | Authentication & password security | [07-authentication-and-password-security.md](./07-authentication-and-password-security.md) |
| 8 | Device & session management | [08-device-and-session-management.md](./08-device-and-session-management.md) |
| 9 | Security monitoring & audit logging | [09-security-monitoring-and-audit-logging.md](./09-security-monitoring-and-audit-logging.md) |
| 10 | Secure data handling | [10-secure-data-handling.md](./10-secure-data-handling.md) |
| 11 | Security testing | [11-security-testing.md](./11-security-testing.md) |
| — | Incident response plan | [incident-response.md](./incident-response.md) |
| — | Backup & disaster recovery | [backup-and-disaster-recovery.md](./backup-and-disaster-recovery.md) |
| — | **Readiness assessment & roadmap** | [readiness-assessment.md](./readiness-assessment.md) |

The vulnerability-disclosure channel lives at the repository root as
[`SECURITY.md`](../../../SECURITY.md), where researchers and tools look for it.

## Architecture at a glance

FleetOS is a single-stack monorepo:

- **`apps/api`** — NestJS 10 + Prisma 5 over **PostgreSQL**, the system of record.
- **`apps/fleethq`** — React 19 + Vite SPA (the back-office web app).
- **`apps/driveros`** — React PWA for drivers (offline-first, IndexedDB outbox).
- **`infra/terraform`** — the AWS production topology (ECS Fargate, RDS,
  CloudFront, Secrets Manager) as code.

The two security foundations everything else builds on:

1. **PostgreSQL Row-Level Security (RLS) multi-tenancy.** The app connects as a
   low-privilege role (`fleetos_app`) and every tenant query runs inside
   `prisma.withTenant(companyId, …)`, which sets a per-transaction
   `app.current_company_id` GUC that RLS policies enforce. One company can never
   read another's rows — enforced by the database, not by application `where`
   clauses. See [03-access-control.md](./03-access-control.md).
2. **Least-privilege database roles.** `fleetos_app` (runtime, RLS-bound),
   `fleetos_auth` (narrow `BYPASSRLS` role for the handful of pre-tenant lookups
   — login, audit of system events), and the schema-owner (migrations only).

## Source of truth

Where this documentation and the code disagree, **the code is correct** and the
doc is stale — please open a fix. The dated engineering self-review at
[`FleetOS-Playbook/14-Security/Security_Review.md`](../../../FleetOS-Playbook/14-Security/Security_Review.md)
is the historical companion to this set.
