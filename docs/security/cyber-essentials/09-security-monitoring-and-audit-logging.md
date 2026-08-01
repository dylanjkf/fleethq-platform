# Security monitoring & audit logging

## Intent

Accountability and detection: a tamper-resistant record of *who did what* to
support investigation and non-repudiation, plus the operational signals needed to
notice an attack in progress. For a multi-tenant platform this record must be
tenant-scoped (one company sees only its own trail) yet still capture the
cross-tenant, pre-authentication events (failed logins) an auditor needs.

## What's implemented

### Append-only security audit trail

- **A dedicated `audit_logs` table, separate from the business Timeline.** The
  Timeline is per-entity business history; the audit log is the security /
  access record an auditor reads — authentications, privilege changes, user
  lifecycle, data subject requests, and credential rotations.
  `apps/api/prisma/migrations/20260724120000_audit_log/migration.sql`,
  `apps/api/src/audit/audit.service.ts`.
- **Append-only by database grant.** The migration enables `FORCE ROW LEVEL
  SECURITY` with a `tenant_isolation` policy and grants the application roles only
  `SELECT, INSERT` — never `UPDATE` or `DELETE`. The application code *cannot*
  rewrite or prune the trail; there is no code path with the privilege to do so.
- **Three write modes, chosen for correctness.**
  `recordInTx` writes the audit row inside the same transaction as the action it
  describes (atomic — the action and its audit line commit or roll back together);
  `record` is a best-effort post-hoc write; `recordSystem` writes pre-tenant
  events (a failed login, before any company context exists) via the narrow
  `BYPASSRLS` auth role. Best-effort writes never throw into the caller's path and
  are mirrored to the structured application log as a backstop.
  `apps/api/src/audit/audit.service.ts`.
- **Events recorded today:**
  - *Authentication* — `auth.login_succeeded`, `auth.login_failed`,
    `auth.account_locked` (each with client IP + request id), `auth.password_reset`.
    `apps/api/src/auth/auth.service.ts`.
  - *Privilege & access-control changes* — `access.role_permissions_changed`
    (`apps/api/src/roles/roles.service.ts`), `access.user_created`,
    `access.user_role_changed`, `access.user_access_revoked`
    (`apps/api/src/users/users.service.ts`). These are recorded atomically with
    the change (`recordInTx`), so a privilege change can never happen without its
    audit line.
  - *Data-subject actions (Australian Privacy Act)* — `privacy.data_exported`,
    `privacy.data_erased`, recorded atomically with the export/erasure.
    `apps/api/src/privacy/privacy.service.ts`.
  - *Credential rotation* — `gps.device_key_rotated` on GPS device-key rotation.
    `apps/api/src/gps/gps.service.ts`.
  - *MFA* — `auth.mfa_enabled`, `auth.mfa_disabled`, `auth.mfa_challenge_failed`.
    `apps/api/src/auth/mfa/mfa.service.ts`, `auth.service.ts`.
  - *Authorization denials* — `access.permission_denied` on every 403 from the
    permission guard, written to the tenant audit log (and stdout) so a burst of
    authorization probing / IDOR-sweeps is visible to a tenant admin.
    `apps/api/src/common/guards/permission.guard.ts`.
  - *Analytics controls* — `analytics.settings_updated` / `_reset`,
    `analytics.override_set` / `_cleared`, `analytics.history_reset`,
    `analytics.day_excluded`. `apps/api/src/analytics/analytics.service.ts`.
  - **Type-safety.** `AuditEventInput.action` is the `AuditAction` union of the
    canonical `AUDIT_ACTIONS` catalog, so a new audited action must be declared
    there — an ad-hoc/typo'd action string fails to compile. High-signal actions
    (privilege changes, data export/erase) are additionally mirrored to stdout
    (`STDOUT_MIRRORED_ACTIONS`) so that a log-based alerting layer can key on them
    *once one exists* (see Gaps — no such alerting is wired today).
- **Tenant-scoped read path.** `GET /v1/audit-logs` returns the calling company's
  own trail, paginated and filterable by action, outcome, actor, target type, and
  a from/to date range, RLS-scoped so one tenant can never read another's events,
  and gated behind the `audit:view` permission. A FleetHQ admin screen consumes it
  at `/audit-log` (nav-gated by `audit:view`), so the trail is reviewable in-app —
  the permission is no longer orphaned. `apps/api/src/audit/audit.controller.ts`,
  `apps/fleethq/src/features/audit/AuditLogPage.tsx`. Covered by e2e:
  `apps/api/test/audit-log.e2e-spec.ts` (deterministic export record, system-level
  failed login via the auth role, `audit:view` 403 gate, tenant isolation, and an
  admin creating a user).
- **Deliberate design — system-level failed logins.** A failed attempt on a
  username that may belong to several companies is not attributable to one
  tenant, so it is recorded with `company_id = null` and is readable only via the
  `BYPASSRLS` auth role — never surfaced in any single tenant's `/v1/audit-logs`.
  This is correct isolation, but it means failed-login *review* has no in-app
  surface yet (see gaps).

### Operational monitoring & tracing

- **Request/trace correlation.** Every request carries a request id propagated
  into structured (`nestjs-pino`) logs, so an audit event, an application log line,
  and an error report can be correlated. `apps/api/src/main.ts` and the logging
  setup.
- **Error monitoring wiring.** Sentry is integrated for 5xx responses (inert
  until `SENTRY_DSN` is set). `apps/api/src/instrument.ts`.
- **Infrastructure alarms.** ⏳ **Planned — not built.** CloudWatch (or
  equivalent) alarms over infrastructure health (task health, database, load
  balancer) require the managed-monitoring infrastructure, which does not exist
  in this repo (no IaC). The managed platform (Railway) surfaces basic service
  health, but no repo-defined alarms are configured.

## Gaps & residual risk

| Gap | Severity | Plan |
|-----|----------|------|
| **No alerting on any security signal.** The audit log *records* failed-login spikes, account-lockout bursts, permission-denial spikes (authz probing), privilege-change bursts, and personal-data export/erase bursts — but nothing evaluates or alerts on them. The previously-claimed CloudWatch metric filters + SNS, GuardDuty threat detection, and multi-region CloudTrail are **⏳ planned target infrastructure and do NOT exist** (no IaC, no `infra/terraform/modules/monitoring`). | high | Build the managed monitoring/alerting layer (metric filters on the mirrored log lines → an alerts channel; account-level threat detection; a tamper-evident audit trail off-box), or an equivalent on the managed platform. |
| Application-level error alerting is inert by default. `SENTRY_DSN` is unset until a Sentry project exists, so 5xx errors are captured to logs but do not page anyone. | medium | Create the Sentry project and set the DSN secret; add a release-health alert rule. |
| System/pre-tenant events (failed logins, lockouts) have no in-app review surface — they are `company_id = null` and invisible to `/v1/audit-logs` by design. | medium | Add a platform-operator (super-admin) view over the system-level audit rows, distinct from the tenant endpoint. |
| No defined retention, archival, or tamper-evidence beyond the append-only grants. The table cannot be edited from the app, but there is no retention policy, off-box archival, or cryptographic chaining. | low | Define an audit-log retention/archival policy (e.g. ship to immutable object storage with object-lock); consider hash-chaining for tamper-evidence. |
| Broader data-access logging is partial. Permission-denied (403) attempts are now audited (`access.permission_denied`) and personal-data export/erasure is audited + alarmed, but read-only report/CSV downloads are still not individually audited. | low | Extend the audit catalog to cover report/CSV exports where they matter for investigation. |

## Standards mapping

**Cyber Essentials:** monitoring & accountability. The append-only, tenant-scoped
audit trail is a strong foundation; the missing piece for operational security is
alerting on the signals it records.

**ISO/IEC 27001:2022 Annex A:** A.8.15 (logging) — strongly met: an append-only,
access-controlled log of security events; A.8.16 (monitoring activities) — partial:
the data exists but active monitoring/alerting is not yet wired; A.5.25
(assessment and decision on security events) — the process depends on the alerting
gap being closed.

**SOC 2 (2017 TSC):** CC7.2 (monitoring for anomalies) — the log exists but
anomaly detection/alerting is the gap; CC7.3 (evaluation of security events) —
supported by the audit trail once alerting routes events to a responder.
