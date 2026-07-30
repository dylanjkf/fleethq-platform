# SOC 2 control matrix (2017 Trust Services Criteria)

Maps the SOC 2 Common Criteria (CC-series) plus the **Availability** and
**Confidentiality** categories to FleetOS controls and evidence. FleetOS targets
a **Security + Availability + Confidentiality** SOC 2; Privacy is partially
addressed via the Australian Privacy Act work.

**Status:** ✅ Implemented · 🟡 Partial · 📝 Planned. A SOC 2 **Type II** report
additionally requires these controls to be shown *operating over an observation
period* by an independent auditor — see [readiness.md](./readiness.md).

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
| CC4.1 | Ongoing/separate evaluations | ✅ | CI security scans (SAST/SCA/secret) every PR + weekly; IaC scan [SEC 04/06] |
| CC4.2 | Evaluate & communicate deficiencies | 🟡 | Dependabot/CodeQL findings tracked; formal remediation-SLA record planned |

## CC5 — Control Activities

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC5.1 | Control activities that mitigate risk | ✅ | Technical controls across [SEC]/[DB]; mapped in [SoA] |
| CC5.2 | Technology general controls | ✅ | IaC, CI/CD gates, least-privilege roles |
| CC5.3 | Policies & procedures deployed | 🟡 | [POL]; enforced technically (parity/lint/scans); management review planned |

## CC6 — Logical & Physical Access (FleetOS's strongest area)

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC6.1 | Logical access security (identify/authenticate/authorize) | ✅ | RLS + RBAC + **MFA** + bcrypt + JWT revocation [SEC 03/07, DB] |
| CC6.2 | Registration/authorization of users | ✅ | Admin-provisioned users + invites; role assignment audited [SEC 03] |
| CC6.3 | Role-based access & least privilege | ✅ | Granular permission catalogue; least-privilege DB roles [DB] |
| CC6.4 | Physical access | ☁️ | AWS data centres (inherited) |
| CC6.5 | Disposal of data/media | 🟡 | KMS crypto-erase; Privacy-Act erasure; versioned-object completeness open [SEC 10] |
| CC6.6 | Boundary protection (external access) | ✅ | Segmented VPC, security groups, no public DB, TLS [SEC 01] |
| CC6.7 | Restrict data transmission | ✅ | TLS everywhere incl. forced DB TLS [SEC 01/10] |
| CC6.8 | Prevent/detect unauthorized software | 🟡 | Immutable images; upload validation; server-side AV planned [SEC 05] |

## CC7 — System Operations

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC7.1 | Detect vulnerabilities/config issues | ✅ | CI SCA + SAST + tfsec; ECR scan-on-push [SEC 04/06] |
| CC7.2 | Monitor for anomalies | 🟡 | Audit log + infra alarms present; **security-signal alerting planned** [SEC 09, RR] |
| CC7.3 | Evaluate security events | ✅ | Incident-response triage; audit log as source [SEC incident-response] |
| CC7.4 | Respond to incidents | ✅ | Incident-response plan (phases, NDB) |
| CC7.5 | Recover from incidents | 🟡 | RDS PITR + cross-region + redeploy; restore drill outstanding [SEC backup-DR] |

## CC8 — Change Management

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC8.1 | Authorize, design, test, approve, deploy changes | ✅ | PR review + CI gates; version-controlled forward-only migrations; manual-approval prod deploy [DB migrations] |

## CC9 — Risk Mitigation

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| CC9.1 | Risk mitigation for business disruption | 🟡 | Multi-AZ + backup/DR; BCP runbook ownership *TBD* |
| CC9.2 | Vendor & business-partner risk | 🟡 | [POL] §Vendor; sub-processor list (AWS/Stripe/SES); DPAs to execute |

## Availability (A1)

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| A1.1 | Capacity to meet objectives | ✅ | Autoscaling ECS; sized pooling; scale test [DB] |
| A1.2 | Backup & recovery infrastructure | ✅ | RDS PITR + cross-region snapshot copy + versioned S3 [SEC backup-DR] |
| A1.3 | Recovery testing | 🟡 | **Timed restore drill outstanding** [RR] |

## Confidentiality (C1)

| # | Criterion | Status | Control & evidence |
|---|-----------|:------:|--------------------|
| C1.1 | Identify & maintain confidential information | 🟡 | Data model + Privacy doc [SEC 10]; formal data classification planned [SoA 5.12] |
| C1.2 | Dispose of confidential information | 🟡 | Privacy-Act erasure + KMS crypto-erase; versioned-object completeness open [SEC 10] |

## Summary

**CC6 (logical access)** and **CC8 (change management)** are fully implemented and
are FleetOS's strongest criteria. **CC1–CC3, CC9** and parts of **CC7** carry the
open items — control environment, risk assessment, monitoring/alerting, and vendor
management — which are governance/organisational work. None require a redesign;
they are policy, ownership, alerting wiring, and the observation period.
