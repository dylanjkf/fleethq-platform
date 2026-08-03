# FleetOS security policies

The core ISMS policy set. Each policy states FleetOS's commitment; the technical
enforcement and evidence live in [`docs/security`](../security/cyber-essentials/)
and [`docs/database`](../database/). **Before an audit, each policy needs a named
owner and a dated management sign-off** — owners are marked *TBD*.

> These are working policies suitable for a small SaaS pursuing ISO 27001 / SOC 2.
> They are deliberately concise and enforceable, not boilerplate.

## 1. Information Security Policy (top-level)

**Owner:** ISMS Owner *(TBD)*. **Review:** annually and on significant change.

FleetOS is committed to protecting the confidentiality, integrity, and
availability of the information entrusted to it by customers — driver personal
data, compliance records, delivery evidence, and operational data. We:

- operate an ISMS aligned to ISO/IEC 27001:2022 and the SOC 2 Trust Services
  Criteria;
- apply **least privilege** and **defence in depth** by default;
- enforce **tenant isolation at the database** (row-level security), never by
  application convention alone;
- maintain an **append-only audit trail** of security-relevant events;
- assess risk and treat it (see [risk-register.md](./risk-register.md)); and
- comply with the Australian Privacy Act 1988 (APPs) and the Notifiable Data
  Breaches scheme.

All staff and contractors with access to FleetOS systems must follow these
policies. Violations are handled under the disciplinary process (§8).

## 2. Access Control Policy

**Owner:** Security Officer *(TBD)*.

- Access is **role-based** (RBAC) and **least privilege**; no feature is gated by
  a hardcoded role check — permissions are granular and resolved server-side.
- Every user has a **unique** identity; shared accounts are prohibited.
- **MFA (TOTP)** is available to all users and **required for administrative
  accounts**.
- Database access uses **three separated roles** (migration-owner, RLS-subject
  runtime, narrow BYPASSRLS) — see [DB security model](../database/security-model.md).
- Access is **granted on provisioning**, **revoked immediately on
  deactivation/offboarding**, and both are **recorded in the audit log**.
- Access rights are **recertified** at least twice yearly *(process to be
  scheduled)*.

## 3. Cryptography Policy

**Owner:** Security Officer *(TBD)*.

- **In transit:** TLS 1.2+ — client↔edge and edge↔API are terminated by the
  managed platform (Railway/Vercel); API↔database requests `sslmode=require`.
  The API advertises HSTS with a 2-year max-age + preload. *(Server-side forced
  DB TLS — `rds.force_ssl` — is ⏳ planned target infra, not yet built.)*
- **At rest:** ⏳ **Planned** — AWS KMS (customer-managed key, rotation enabled)
  for the database and object storage is target architecture; there is **no IaC
  in this repo** to define it. At-rest encryption today is whatever the managed
  platform provides by default.
- **Secrets:** sourced from the platform's environment configuration (Railway
  **Variables**) at runtime; never in images or the repository. Boot fails if a
  dev-only credential is detected in production. *(A managed secret store such as
  AWS Secrets Manager is a ⏳ planned option, not currently used.)*
- **Passwords:** bcrypt (cost ≥ 10). **Tokens:** JWT HS256 (algorithm pinned),
  with a tokenVersion revocation mechanism. **Device keys:** SHA-256 hashed.
- Deprecated algorithms (MD5, SHA-1 for signatures, DES) are not used for
  security purposes (SHA-1 appears only inside the RFC-defined TOTP HMAC).

## 4. Data Classification & Retention Policy

**Owner:** Privacy Officer *(TBD)*.

- **Classes:** Public · Internal · Confidential · Restricted (PII/credentials).
  Driver/customer contact details, licence/medical document numbers, GPS history,
  and delivery proof are **Restricted**.
- Restricted data is encrypted in transit (TLS). Stored secrets (integration
  credentials) are additionally encrypted at rest at the application layer
  (AES-256-GCM); database/disk-level at-rest encryption is provided by the
  managed host's defaults rather than a repo-defined control (see `readiness.md`).
  Restricted data is access-controlled by RLS, and access is logged.
- **Retention:** operational data is retained for the life of the customer
  relationship; the high-growth append-only tables (`gps_pings`,
  `timeline_events`, `notifications`) have defined retention floors and a
  scheduled purge *(GPS breadcrumbs 12–24 months; to be implemented — R4)*; audit
  logs are retained per the longest applicable obligation.
- **Deletion:** customer PII is erasable on request (Australian Privacy Act) via
  field redaction + attachment destruction; **versioned-object completeness is
  being closed (R5)**.

## 5. Secure Development Policy

**Owner:** Engineering Lead *(TBD)*.

- All changes go through **pull request + code review** with required, green CI
  before merge *(branch protection to be enabled — R14; no CODEOWNERS committed
  yet)*.
- CI (`api-ci.yml`) enforces: **lint, typecheck, tests (on a real Postgres),
  migrations, seed, build**. **Dependency updates** are handled by Dependabot
  (`.github/dependabot.yml`), and a scheduled dump/restore drill
  (`restore-drill.yml`) guards schema/restore drift.
- ⏳ **Planned (not yet wired — no `security-scan.yml`/`terraform-ci.yml`):** an
  `npm audit` CI gate, **SAST (CodeQL)**, **secret scanning (gitleaks)**, and
  **IaC scanning (tfsec)**. These must not be represented as in force.
- Queries are parameterised (Prisma); inputs are validated by DTO whitelisting;
  authorization is applied on every route; tenant isolation is RLS-by-default.
- Dev/test/production are separated; no production data is used in tests.
- Production deploys are **manually approved** and run forward-only migrations.

## 6. Acceptable Use & Endpoint Policy

**Owner:** Ops *(TBD)*.

- Staff devices with access to FleetOS systems must use full-disk encryption, an
  auto-lock screen, a supported OS with automatic updates, and reputable
  anti-malware.
- Credentials must not be shared or reused; MFA must be enabled where offered.
- Production access is limited to those who need it for their role; ad-hoc
  production database access outside the deploy/migration path is prohibited.

## 7. HR Security Policy

**Owner:** HR/Founder *(TBD)*.

- **Screening** (background checks) for staff with production/data access, where
  lawful.
- Security responsibilities and confidentiality obligations are in **employment
  terms / NDAs**.
- **Onboarding** includes security-awareness training; **annual refresher**
  thereafter.
- **Offboarding** revokes all access (technically immediate + audited) and
  recovers assets on the same day.

## 8. Supplier / Vendor Management Policy

**Owner:** Legal/Founder *(TBD)*.

- Primary sub-processors reflect the actual deployment: **Railway** (API hosting
  + managed Postgres), **Vercel** (frontend hosting), **Stripe** (billing, when
  enabled), an **email provider** such as AWS SES (transactional email, when
  enabled), and **Sentry** (error tracking, when enabled). Each is a reputable
  provider with its own security attestations. *(An AWS-hosted topology is a
  planned future option, not the current arrangement.)*
- **Data Processing Agreements** are executed with each sub-processor handling
  personal data *(drafts in 20-Legal — to execute)*.
- Sub-processors are reviewed at least annually for continued compliance.

## 9. Business Continuity & Incident Response

Operational detail lives with the technical controls:
[incident response](../security/cyber-essentials/incident-response.md) (severity
tiers, phases, Australian NDB obligations) and
[backup & DR](../security/cyber-essentials/backup-and-disaster-recovery.md)
(RPO ≈ 5 min, RTO in hours; **restore drill outstanding — R6**).

## 10. Governance & Management Review

**Owner:** ISMS Owner *(TBD)*.

- Management reviews the ISMS (risk register, incidents, audit findings, control
  effectiveness, this policy set) at least **quarterly** *(cadence to be
  scheduled)*.
- The **Statement of Applicability** ([statement-of-applicability.md](./statement-of-applicability.md))
  is the authoritative record of control applicability and status.
- An **independent review / penetration test** is commissioned before, and
  periodically after, certification (ISO A.5.35).
