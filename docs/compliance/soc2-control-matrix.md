# SOC 2 control matrix (2017 Trust Services Criteria)

Maps the SOC 2 Common Criteria (CC-series) plus the **Availability** and
**Confidentiality** categories to FleetOS controls and evidence. FleetOS targets
a **Security + Availability + Confidentiality** SOC 2; Privacy is partially
addressed via the Australian Privacy Act work.

**Status:** ✅ Implemented (verifiable from a file in `api/` or `.github/`) · 🔶 Partial — application layer only · 🟡 Partial · 📝 Planned · ⏳ Planned — infrastructure target architecture, not yet built (no IaC in repo). A SOC 2 **Type II** report additionally requires these controls to be shown *operating over an observation period* by an independent auditor — see [readiness.md](./readiness.md).

> **Built vs. target.** Infrastructure-layer controls (network, WAF, KMS-at-rest,
> managed monitoring, multi-AZ/cross-region DB) are **not yet built — there is no
> Terraform or other IaC in this repository** — and are marked **⏳**. No control
> below is marked Implemented on the basis of a file that does not exist.

References: [SEC] `docs/security/cyber-essentials/`, [DB] `docs/database/`,
[POL] `security-policies.md`, [SoA] `statement-of-applicability.md`.

## CC1 — Control Environment

| # | Criterion (summary) | Status | Control & evidence |
|---|---------------------|:------:|--------------------|
| CC1.1 | Integrity & ethical values | 🟡 | [POL] §Governance, code of conduct; sign-off *TBD* |
| CC1.2 | Board/management oversight | 📝 | Management-review cadence to be scheduled |
| CC1.3 | Structures, reporting lines, authorities | 🟡 | [POL] §Roles; named owners *TBD* |
| CC1.4 | Commitment to competence | 📝 | [POL] §HR — training programme |
| CC1.5 | Accountability | 🟡 | RBAC + audit trail hold users accountable [SEC 03/09]; HR accountability planned |

## CC2 — Communication & Information

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC2.1 | Quality information for control | ✅ | Append-only audit log + structured logs + CI records [SEC 09] |
| CC2.2 | Internal communication of responsibilities | 🟡 | This ISMS doc set; engineering README; onboarding planned |
| CC2.3 | External communication | ✅ | SECURITY.md disclosure channel; status/incident comms plan [SEC incident-response] |

## CC3 — Risk Assessment

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC3.1 | Objectives to identify/assess risk | 🟡 | [risk-register.md] |
| CC3.2 | Identify & analyse risk | 🟡 | Risk register with likelihood/impact |
| CC3.3 | Consider fraud potential | 🟡 | Audit trail + least privilege deter/ detect; formal fraud assessment planned |
| CC3.4 | Identify & assess change | ✅ | Change management via CI + migrations [DB]; risk review on significant change |

## CC4 — Monitoring Activities

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC4.1 | Ongoing/separate evaluations | 🔶 | `api-ci.yml` runs the app test suite on every PR; Dependabot raises update PRs. Dedicated CI security scans (SAST/SCA-gate/secret/IaC) are ⏳ planned — no `security-scan.yml`/`terraform-ci.yml` [SEC 04/06] |
| CC4.2 | Evaluate & communicate deficiencies | 🟡 | Dependabot/CodeQL findings tracked; formal remediation-SLA record planned |

## CC5 — Control Activities

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC5.1 | Control activities that mitigate risk | ✅ | Technical controls across [SEC]/[DB]; mapped in [SoA] |
| CC5.2 | Technology general controls | 🔶 | Least-privilege DB roles + `api-ci.yml` gate + forward-only migrations (implemented); IaC is ⏳ planned (none in repo) |
| CC5.3 | Policies & procedures deployed | 🟡 | [POL]; enforced technically (parity/lint/scans); management review planned |

## CC6 — Logical & Physical Access (FleetOS's strongest area)

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC6.1 | Logical access security (identify/authenticate/authorize) | ✅ | RLS + RBAC + **MFA** + bcrypt + JWT revocation [SEC 03/07, DB] |
| CC6.2 | Registration/authorization of users | ✅ | Admin-provisioned users + invites; role assignment audited [SEC 03] |
| CC6.3 | Role-based access & least privilege | ✅ | Granular permission catalogue; least-privilege DB roles [DB] |
| CC6.4 | Physical access | ☁️ | Hosting-provider data centres (inherited) |
| CC6.5 | Disposal of data/media | 🟡 | KMS crypto-erase; Privacy-Act erasure; versioned-object completeness open [SEC 10] |
| CC6.6 | Boundary protection (external access) | ⏳ | Segmented VPC, security groups, no public DB — planned target architecture, not built (no IaC). App-tier rate limiting + managed-edge TLS are the in-force boundary today [SEC 01] |
| CC6.7 | Restrict data transmission | 🔶 | TLS in transit via the managed edge + `sslmode=require`; server-side forced DB TLS is ⏳ planned [SEC 01/10] |
| CC6.8 | Prevent/detect unauthorized software | 🟡 | Immutable images; upload validation; server-side AV planned [SEC 05] |

## CC7 — System Operations

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC7.1 | Detect vulnerabilities/config issues | 🔶 | Dependabot in force; boot-time env validation catches misconfig. CI SCA-gate + SAST + tfsec + ECR scan-on-push are ⏳ planned (no `security-scan.yml`) [SEC 04/06] |
| CC7.2 | Monitor for anomalies | 🟡 | Audit log recorded (app); managed monitoring/alerting ⏳ planned — no infra alarms exist yet [SEC 09, RR] |
| CC7.3 | Evaluate security events | ✅ | Incident-response triage; audit log as source [SEC incident-response] |
| CC7.4 | Respond to incidents | ✅ | Incident-response plan (phases, NDB) |
| CC7.5 | Recover from incidents | 🔶 | Forward-only migrations + managed-platform redeploy + CI dump/restore drill (implemented); managed-DB PITR + cross-region + live-DB restore drill are ⏳ planned [SEC backup-DR] |

## CC8 — Change Management

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC8.1 | Authorize, design, test, approve, deploy changes | ✅ | PR review + `api-ci.yml` gate; version-controlled forward-only migrations; manual-approval prod deploy on the managed platform [DB migrations] |

## CC9 — Risk Mitigation

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC9.1 | Risk mitigation for business disruption | 🟡 | CI dump/restore drill (implemented); multi-AZ + managed-DB backup/DR are ⏳ planned; BCP runbook ownership *TBD* |
| CC9.2 | Vendor & business-partner risk | 🟡 | [POL] §Vendor; sub-processor list (AWS/Stripe/SES); DPAs to execute |

## Availability (A1)

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| A1.1 | Capacity to meet objectives | 🔶 | Sized connection pooling + scale test (app) [DB]; horizontal autoscaling is ⏳ planned (managed-platform/infra) |
| A1.2 | Backup & recovery infrastructure | 🔶 | CI dump/restore drill (`restore-drill.yml`); managed-DB PITR + cross-region snapshot copy + versioned S3 are ⏳ planned [SEC backup-DR] |
| A1.3 | Recovery testing | 🔶 | Dump/restore script drilled weekly in CI; **timed restore of a live managed database (actual RPO/RTO) still outstanding** [RR] |

## Confidentiality (C1)

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| C1.1 | Identify & maintain confidential information | 🟡 | Data model + Privacy doc [SEC 10]; formal data classification planned [SoA 5.12] |
| C1.2 | Dispose of confidential information | 🟡 | Privacy-Act erasure + KMS crypto-erase; versioned-object completeness open [SEC 10] |

## Summary

The **logical-access** core of **CC6** (CC6.1/6.2/6.3 — RLS, RBAC, MFA,
least-privilege roles) and **CC8 (change management)** are fully implemented and
are FleetOS's strongest criteria. The **boundary/network** parts of CC6 (CC6.6,
and the server-side transport half of CC6.7) depend on the **⏳ planned**
infrastructure topology (VPC/WAF/forced-DB-TLS) that is **not yet built**.
**CC1–CC3, CC9** and parts of **CC7** carry the remaining open items — control
environment, risk assessment, monitoring/alerting (which needs the managed
monitoring infra), and vendor management — largely governance/organisational plus
the unbuilt infrastructure layer, not an application redesign.
