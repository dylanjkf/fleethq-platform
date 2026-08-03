# Statement of Applicability — ISO/IEC 27001:2022 Annex A

The SoA is the central ISO 27001 artefact: for every Annex A control it records
whether it applies, its implementation status, and the evidence. FleetOS is a
cloud-hosted multi-tenant SaaS with a remote team and **no physical premises**.
The current deployment runs on **managed platforms** (API on Railway, frontends
on Vercel); a fuller AWS topology is a *planned target*. Most Annex A **7
(Physical)** controls are either inherited from the hosting provider under the
shared-responsibility model (their data centres are themselves ISO 27001 / SOC 2
certified) or not applicable.

> **Built vs. target.** Application-layer controls are implemented in `api/`.
> Infrastructure-layer controls (network segmentation, WAF, KMS-at-rest, managed
> monitoring, multi-AZ / cross-region DB) are a **target architecture and are NOT
> yet built — there is no Terraform or other IaC in this repository.** Such rows
> are marked **⏳** and must not be represented as implemented.

**Status legend:** ✅ Implemented (verifiable from a file in this repo) · 🔶 Partial — application layer only · 🟡 Partial · 📝 Planned (documented, owner/action outstanding) · ⏳ Planned — infrastructure target architecture, not yet built (no IaC in repo) · ☁️ Inherited (hosting provider) · ➖ Not applicable.

Evidence references point at this repository (`api/…` layout) unless noted.
Cross-references: [SEC] = `docs/security/cyber-essentials/`, [DB] = `docs/database/`,
[POL] = `security-policies.md`, [RR] = `risk-register.md`.

## A.5 Organizational controls (5.1–5.37)

| Control | Status | Evidence / note |
|---------|:------:|-----------------|
| 5.1 Policies for information security | ✅ | [POL] security-policies.md; this ISMS documentation set |
| 5.2 Information security roles & responsibilities | 🟡 | [POL] §Roles — roles defined; named owners *TBD* before audit |
| 5.3 Segregation of duties | 🟡 | RBAC + least-privilege DB roles [DB]; last-admin lockout guard; formal SoD matrix planned |
| 5.4 Management responsibilities | 📝 | [POL] §Governance; management-review cadence to be scheduled |
| 5.5 Contact with authorities | 📝 | Incident-response plan names OAIC (NDB); authority contact list *TBD* |
| 5.6 Contact with special interest groups | 📝 | Planned (e.g. AusCERT membership) |
| 5.7 Threat intelligence | 🟡 | Dependabot advisories + GitHub security advisories (`.github/dependabot.yml`); CodeQL SAST is ⏳ planned, not wired [SEC 04/06] |
| 5.8 Information security in project management | 🟡 | Secure-SDLC gates in CI [SEC 06]; formalise in project checklist |
| 5.9 Inventory of information & associated assets | 🟡 | Data model is the information inventory [DB]; formal asset register planned (infra-as-code inventory is ⏳ planned — no IaC exists yet) |
| 5.10 Acceptable use of assets | 📝 | [POL] §Acceptable use |
| 5.11 Return of assets | 📝 | [POL] §HR — offboarding checklist |
| 5.12 Classification of information | 📝 | [POL] §Data classification — scheme defined; field-level tagging planned [RR] |
| 5.13 Labelling of information | 📝 | Follows 5.12 |
| 5.14 Information transfer | 🔶 | TLS in transit via the managed edge (Railway/Vercel) + `sslmode=require` in the DB connection strings; server-side forced DB TLS is ⏳ planned (managed-platform/infra) [SEC 01/10] |
| 5.15 Access control | ✅ | PostgreSQL RLS multi-tenancy + RBAC [DB security-model, SEC 03] |
| 5.16 Identity management | ✅ | Unique global user identities; multi-company membership model [DB] |
| 5.17 Authentication information | ✅ | bcrypt password hashing, strength policy, **MFA (TOTP)** [SEC 07] |
| 5.18 Access rights | ✅ | Granular permission catalogue; provisioning/deprovisioning; access-revoked audited [SEC 03] |
| 5.19 Information security in supplier relationships | 🟡 | [POL] §Vendor management; AWS/Stripe/SES are primary sub-processors |
| 5.20 Addressing security in supplier agreements | 📝 | DPA drafts exist (20-Legal); execute with sub-processors |
| 5.21 Security in the ICT supply chain | 🔶 | Dependabot for npm + GitHub Actions (`.github/dependabot.yml`); base image pinned. An `npm audit` gate, a committed SCA gate, and gitleaks secret scanning are ⏳ planned (no `security-scan.yml`) [SEC 04/06] |
| 5.22 Monitoring/review of supplier services | 📝 | Periodic sub-processor review to be scheduled |
| 5.23 Information security for use of cloud services | 🔶 | Managed platforms (Railway/Vercel) under shared-responsibility; runtime config via env vars. IaC-defined, tfsec-scanned infrastructure is ⏳ planned — no IaC or `terraform-ci` exists [SEC 01] |
| 5.24 Incident management planning & preparation | ✅ | [SEC] incident-response.md (severity tiers, phases, NDB) |
| 5.25 Assessment & decision on events | ✅ | Incident-response §triage; audit log as source |
| 5.26 Response to incidents | ✅ | Incident-response §phases |
| 5.27 Learning from incidents | ✅ | Incident-response §post-incident review |
| 5.28 Collection of evidence | ✅ | Append-only `audit_logs` (no UPDATE/DELETE grant) [SEC 09]; managed log retention (CloudWatch) is ⏳ planned |
| 5.29 Information security during disruption | 🟡 | Multi-AZ + cross-region snapshot copy are ⏳ planned (no IaC); DR runbook ownership *TBD* [SEC backup-DR] |
| 5.30 ICT readiness for business continuity | 🟡 | Dump/restore drill automated in CI (`restore-drill.yml`); managed-DB backup topology ⏳ planned; live-DB restore (RPO/RTO) outstanding [RR] |
| 5.31 Legal, statutory, regulatory & contractual requirements | ✅ | Australian Privacy Act (APPs, NDB) addressed [SEC 10, Privacy_Data_Protection.md]; ToS/Privacy/DPA drafts |
| 5.32 Intellectual property rights | ✅ | Dependency licences via npm; proprietary code in private repo |
| 5.33 Protection of records | 🔶 | Append-only audit log (implemented) [SEC 09]; managed-DB PITR + versioned S3 are ⏳ planned [backup-DR] |
| 5.34 Privacy & protection of PII | ✅ | Privacy Act export/erasure path; RLS; encryption [SEC 10] |
| 5.35 Independent review of information security | 📝 | Independent penetration test + external audit are the certification path [readiness.md] |
| 5.36 Compliance with policies/standards | 🟡 | CI-enforced technical policy (parity, lint, scans); management-review compliance check planned |
| 5.37 Documented operating procedures | ✅ | Runbooks: deploy, backup/DR, incident response; engineering README |

## A.6 People controls (6.1–6.8)

| Control | Status | Evidence / note |
|---------|:------:|-----------------|
| 6.1 Screening | 📝 | [POL] §HR — background checks for staff with production access |
| 6.2 Terms & conditions of employment | 📝 | [POL] §HR — security responsibilities in contracts |
| 6.3 Security awareness, education & training | 📝 | [POL] §HR — onboarding security training + annual refresh |
| 6.4 Disciplinary process | 📝 | [POL] §HR |
| 6.5 Responsibilities after termination/change | 🟡 | Access revocation is immediate + audited (technical) [SEC 03]; HR checklist planned |
| 6.6 Confidentiality / NDAs | 📝 | [POL] §HR / §Vendor — NDAs for staff and sub-processors |
| 6.7 Remote working | 🟡 | Bearer-token sessions, MFA, TLS; formal remote-working policy in [POL] |
| 6.8 Information security event reporting | ✅ | SECURITY.md disclosure channel; internal reporting to Incident Lead |

## A.7 Physical controls (7.1–7.14)

FleetOS operates no physical facilities; production currently runs on managed cloud hosting (Railway + Vercel). AWS ap-southeast-2 is the planned target environment (not yet provisioned).

| Control | Status | Evidence / note |
|---------|:------:|-----------------|
| 7.1 Physical security perimeters | ☁️ | AWS data-centre certifications |
| 7.2 Physical entry | ☁️ | AWS |
| 7.3 Securing offices/rooms/facilities | ➖ | No FleetOS premises (remote team) |
| 7.4 Physical security monitoring | ☁️ | AWS |
| 7.5 Protecting against physical/environmental threats | ☁️ | AWS (multi-AZ) |
| 7.6 Working in secure areas | ➖ | N/A |
| 7.7 Clear desk & clear screen | 🟡 | [POL] §Acceptable use — device lock policy for remote staff |
| 7.8 Equipment siting & protection | ☁️ | AWS |
| 7.9 Security of assets off-premises | 🟡 | [POL] §HR — endpoint policy (disk encryption, screen lock) |
| 7.10 Storage media | ☁️ | AWS-managed; no removable media in the pipeline |
| 7.11 Supporting utilities | ☁️ | AWS |
| 7.12 Cabling security | ☁️ | AWS |
| 7.13 Equipment maintenance | ☁️ | AWS |
| 7.14 Secure disposal or re-use of equipment | ☁️ | Hosting-provider media destruction (managed platform); S3/RDS KMS crypto-erase is ⏳ planned (target infra) [SEC 10] |

## A.8 Technological controls (8.1–8.34)

| Control | Status | Evidence / note |
|---------|:------:|-----------------|
| 8.1 User endpoint devices | 🟡 | [POL] §HR endpoint policy; no MDM yet [RR] |
| 8.2 Privileged access rights | ✅ | Least-privilege DB roles; BYPASSRLS role narrow; migration-only owner [DB] |
| 8.3 Information access restriction | ✅ | RLS + RBAC; permission guard [DB, SEC 03] |
| 8.4 Access to source code | 🟡 | Private repo; branch protection + CODEOWNERS to be enabled [RR] |
| 8.5 Secure authentication | ✅ | MFA (TOTP), bcrypt, JWT revocation, algorithm pinned, lockout [SEC 07] |
| 8.6 Capacity management | 🔶 | Sized connection pooling + scale test (app) [DB]; horizontal autoscaling is ⏳ planned (managed-platform/infra) |
| 8.7 Protection against malware | 🟡 | Upload type/magic-byte validation + size caps [SEC 05]; server-side AV scan planned [RR] |
| 8.8 Management of technical vulnerabilities | 🔶 | Dependabot (`.github/dependabot.yml`) is in force; `npm audit` runnable in `api/`. A committed audit gate, CodeQL, and a weekly scan are ⏳ planned (no `security-scan.yml`) [SEC 04] |
| 8.9 Configuration management | 🔶 | Fail-fast env validation at boot (app) [SEC 02]; IaC (Terraform) + tfsec are ⏳ planned — no IaC exists |
| 8.10 Information deletion | 🟡 | Privacy-Act erasure (field redaction + S3 delete); versioned-object erasure completeness open [SEC 10, RR] |
| 8.11 Data masking | 🟡 | GPS device keys hashed; passwords hashed; broader PII masking planned |
| 8.12 Data leakage prevention | 🟡 | RLS; log redaction; egress restricted to AWS SG; formal DLP not in scope |
| 8.13 Information backup | 🔶 | Dump/restore drill automated in CI (`restore-drill.yml`); managed-DB automated backups + PITR + cross-region snapshot copy are ⏳ planned (no IaC) [SEC backup-DR] |
| 8.14 Redundancy of processing facilities | ⏳ | Multi-AZ DB + multi-instance compute + CDN are planned target architecture — not built (no IaC) [SEC 01] |
| 8.15 Logging | ✅ | Append-only `audit_logs`; structured pino logs with request ids [SEC 09] |
| 8.16 Monitoring activities | 🟡 | Audit trail recorded (app); managed monitoring/alerting (CloudWatch metric filters/alarms) is ⏳ planned [SEC 09, RR] |
| 8.17 Clock synchronization | ☁️ | Managed-platform NTP on the host |
| 8.18 Use of privileged utility programs | ✅ | No ad-hoc prod DB access by app role; migrations via a separate role/job |
| 8.19 Installation of software on operational systems | ✅ | Per-deploy container image built from the pinned `api/Dockerfile`; no in-place installs (a scan-on-push registry/ECR is ⏳ planned) |
| 8.20 Networks security | ⏳ | Segmented VPC, security groups, no public DB — planned target architecture, not built (no IaC) [SEC 01] |
| 8.21 Security of network services | ⏳ | ALB/CloudFront TLS policies + forced DB TLS are planned; TLS in transit today is managed-edge-provided [SEC 01] |
| 8.22 Segregation of networks | ⏳ | Public/private subnets + chained security groups are planned (no IaC); tenant segregation is enforced today by DB RLS [SEC 01] |
| 8.23 Web filtering | 🟡 | App-tier throttling in force; edge WAF is ⏳ planned (egress N/A for a SaaS backend) [RR] |
| 8.24 Use of cryptography | 🔶 | bcrypt + device-key hashing + TLS in transit (managed edge) implemented; KMS encryption-at-rest is ⏳ planned; [POL] §Cryptography |
| 8.25 Secure development life cycle | 🔶 | `api-ci.yml` runs lint, typecheck, tests, migrations, seed, build; SAST/SCA-gate/secret-scan are ⏳ planned (no `security-scan.yml`) [SEC 06] |
| 8.26 Application security requirements | ✅ | DTO validation (whitelist), authz on every route, RLS by default |
| 8.27 Secure system architecture & engineering principles | ✅ | RLS-by-default, least privilege, defense-in-depth documented [DB, SEC] |
| 8.28 Secure coding | 🔶 | eslint + parameterised queries (Prisma) implemented; CodeQL security queries are ⏳ planned [SEC 06] |
| 8.29 Security testing in development & acceptance | ✅ | Tenant-isolation + auth + MFA + audit e2e + scale test on a real Postgres via `api-ci.yml` [SEC 11] (SAST is ⏳ planned) |
| 8.30 Outsourced development | ➖ | Development is in-house |
| 8.31 Separation of dev/test/production | 🔶 | Throwaway per-run test DB in CI (implemented); per-environment isolated infra (Railway environments / tfvars) is a deployment-time setup, not IaC in this repo [SEC 02] |
| 8.32 Change management | ✅ | Version-controlled forward-only migrations; PR + `api-ci.yml`; manual-approval prod deploy on the managed platform [DB migrations] |
| 8.33 Test information | ✅ | Test tenants are synthetic/randomised; no production data in tests |
| 8.34 Protection of information systems during audit testing | ✅ | Read-only audit access via `audit:view`; append-only trail |

## Summary

Of the 93 Annex A controls: the **application-layer** technological controls
(access, logging, crypto-in-transit, secure development at the app tier, input
validation, change management via `api-ci.yml`) are **Implemented**; the
**infrastructure-layer** technological controls (network segmentation, WAF,
KMS-at-rest, managed monitoring, multi-AZ/cross-region backup) are **⏳ Planned
target architecture — not yet built, no IaC in this repo** and must not be
represented as implemented; physical controls are **inherited from the hosting
provider or N/A**; and the **Planned/Partial** organisational items (A.5/A.6) —
signed policies, HR processes, named owners, the independent review — are the
governance work that [readiness.md](./readiness.md) sequences toward
certification.
