# External audit & engagement plan (Phase 3)

> **What this is:** the artefacts you hand to external parties to *start*
> certification. A repository cannot *perform* a penetration test, *be* a CPA
> firm, or *run* a 3–12 month observation — those are external, time-bound acts.
> This document is the evidence register and engagement runbook that make them
> straightforward to commission.

## 3.1 Evidence register (for the auditor)

Every control an auditor tests points to concrete, retrievable evidence. This is
where each lives.

| Control area | Evidence | Where / how to retrieve |
|--------------|----------|--------------------------|
| Tenant isolation (RLS) | Policy definitions + passing isolation test | `apps/api/prisma/migrations/*rls*`; `test/tenant-isolation.e2e-spec.ts`; live: `pg_policies` |
| Access control / RBAC | Permission catalogue + guard + tests | `apps/api/src/common/permissions/`; `permission.guard.ts`; `docs/security/cyber-essentials/03-access-control.md` |
| MFA | Implementation + tests | `apps/api/src/auth/mfa/`; `test/mfa.e2e-spec.ts` |
| Audit trail | Append-only table + read endpoint + tests | migration `*_audit_log`; `src/audit/`; `test/audit-log.e2e-spec.ts`; live: query `audit_logs` |
| Encryption (rest/transit) | IaC (KMS, force_ssl, TLS policies) | `infra/terraform/modules/{database,api-service,frontend}` |
| CI security gates | Workflow runs (SAST/SCA/secret/IaC scans) | `.github/workflows/`; GitHub Actions run history |
| Change management | PR history + required checks + migrations | GitHub PRs; `apps/api/prisma/migrations/`; CODEOWNERS |
| Backup/DR | IaC + (once run) restore-drill record | `docs/security/cyber-essentials/backup-and-disaster-recovery.md`; drill log |
| Monitoring/alerting | Metric filters + alarms + SNS | `infra/terraform/modules/monitoring` |
| Data retention/erasure | Retention job + erasure code + tests | `src/retention/`; `src/privacy/`; `test/retention.e2e-spec.ts` |
| Risk management | Risk register | `docs/compliance/risk-register.md` |
| Policies + approvals | Policy set + sign-off log | `docs/compliance/security-policies.md`; `governance-execution.md` §2.2 |
| Incident management | Plan + (any) incident records | `docs/security/cyber-essentials/incident-response.md` |
| Access reviews / HR | Recertification + onboarding/offboarding records | `governance-execution.md` §2.3/§2.5 |

For a Type II observation, the **audit log**, **CI run history**, and the
**management-review / access-review logs** are the continuous evidence that
controls *operated* throughout the period.

## 3.2 Independent penetration test — scope / RFP

Commission before, or immediately after, the first enterprise customer's data
lands (ISO A.5.35 / SOC 2 supports CC4.1).

- **Targets:** the API (`api.<domain>`), FleetHQ SPA, DriverOS PWA, and the
  authentication/MFA flows. Grey-box (provide test tenant accounts across
  roles).
- **Priorities:** (1) **cross-tenant access** — attempt to read/write another
  company's data by every vector (IDOR, forced browsing, token replay, GPS
  device-key abuse); (2) authn/authz — MFA bypass, session/token handling,
  privilege escalation; (3) injection & input handling; (4) file-upload abuse;
  (5) rate-limit / brute-force resilience.
- **Rules of engagement:** test environment or a clearly-scoped production window;
  no destructive tests against real customer data; findings disclosed privately
  per `SECURITY.md`.
- **Deliverable:** a report with severity-rated findings and remediation
  guidance; retest after remediation. File the report as evidence and feed
  findings into the risk register.

## 3.3 SOC 2 engagement & observation-period runbook

1. **Choose scope:** Security (required) + Availability + Confidentiality (this
   documentation targets these). Decide **Type I** (design, point-in-time — can
   be obtained quickly) vs **Type II** (operating effectiveness over a period).
2. **Engage a CPA firm** experienced with SaaS. Provide this `docs/compliance/`
   set + `docs/security/` + `docs/database/` as the control documentation.
3. **Readiness assessment** with the auditor (gap analysis) — close any gaps.
4. **Type I** first if you need something to show procurement quickly (a
   point-in-time report + a bridge letter).
5. **Type II observation period (3–12 months):** operate the controls and collect
   evidence continuously — the audit log, CI history, quarterly management
   reviews, access recertifications, incident records, and the restore-drill log.
6. **Audit fieldwork → report.** Share the report (under NDA) with customers who
   request it.

## 3.4 ISO 27001 certification runbook

1. **Confirm ISMS scope** and finalise the SoA
   ([statement-of-applicability.md](./statement-of-applicability.md)).
2. **Assign owners + sign policies + run one management review** (Phase 2) —
   ISO requires the ISMS to be *operating*, not just documented.
3. **Engage an accredited certification body.**
4. **Stage 1 audit** (documentation review): SoA, policies, risk assessment,
   scope. Close findings.
5. **Stage 2 audit** (implementation): the body samples evidence that controls
   operate. Close any nonconformities.
6. **Certification** (3-year cycle with annual surveillance audits).

## Bottom line

Phases 1 and the *documentation* half of 2/3 are done in this repository. What
genuinely remains is **human and external**: named owners signing the policies
(Phase 2), and an independent tester + a CPA firm + a certification body running
their processes over time (Phase 3). This plan is what you hand them to begin —
FleetOS enters those engagements **audit-ready**, not starting from zero.
