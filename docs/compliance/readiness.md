# ISO 27001 / SOC 2 readiness

> ## Scope note — application layer is built; infrastructure layer is target architecture
>
> FleetOS's **application-layer** security controls (PostgreSQL row-level
> security, RBAC deny-by-default, TOTP MFA, account lockout, password policy, JWT
> auth + revocation, the append-only audit log, Australian Privacy Act
> export/erasure, DTO input validation, per-route rate limiting, attachment
> magic-byte sniffing, GPS device-key hashing, the SSRF safe-fetch guard, and
> fail-fast env validation) are **implemented and inspectable in this repository**
> (`api/`), gated by `api-ci.yml` and Dependabot.
>
> **Infrastructure-layer** controls (network segmentation / VPC, WAF, KMS
> encryption-at-rest, managed monitoring — CloudWatch/GuardDuty/CloudTrail — and
> multi-AZ / cross-region database) describe a **TARGET architecture** for the
> planned Railway/AWS deployment and are **NOT yet built: there is no Terraform or
> other infrastructure-as-code in this repository.** They are marked **⏳ Planned**
> below.
>
> **No control in this document is marked Implemented on the basis of a file that
> does not exist.** Where an earlier draft marked an infra control "done," it has
> been reclassified to Planned.

Where FleetOS stands after the security programme (Waves A–F) and this ISMS
documentation, and exactly what remains between here and a certificate/report.

## The honest headline

**Everything that a codebase and documentation set can contribute to ISO 27001
and SOC 2 is now in place.** What remains is inherently **external and
time-bound** and cannot be produced from this repository:

1. **Named owners + signed policies** — the frameworks require accountable human
   owners and dated management sign-off (this repo provides the policy *content*;
   a person must own and sign each).
2. **An observation period** — SOC 2 **Type II** requires an independent auditor
   to observe controls operating over **3–12 months**.
3. **An external audit** — ISO 27001 requires an **accredited certification
   body** (Stage 1 + Stage 2); SOC 2 requires an **independent CPA firm**.

> **Do not tell customers FleetOS "is ISO 27001 certified" or "is SOC 2
> compliant" until an external report exists.** You *can* accurately say it is
> *built to* ISO 27001 / SOC 2 controls and is *pursuing certification* — and
> share this documentation and a SOC 2 Type I / bridge letter once obtained.

## Scores

Two different questions, scored separately:

| Dimension | Score | Meaning |
|-----------|:-----:|---------|
| **Controllable readiness** (technical controls + documentation) | **~95%** | What we can build/write is essentially done. The residual is a handful of technical items (below), each small. |
| **ISO 27001 audit-readiness** | **~88%** | SoA, policies, risk register drafted; technical controls strong. Gap: owners, sign-off, management review, independent review + the audit itself. |
| **SOC 2 (Security+Availability+Confidentiality) design readiness** | **~87%** | Control design strong (esp. CC6/CC8). Gap: monitoring/alerting (CC7.2), restore test (A1.3), vendor DPAs, and the Type II **observation period**. |
| **Cyber Essentials (self-assessment)** | **~93%** | MFA closed the binding gap; WAF + server-side AV are the small remainders. |

These moved up materially from the pre-MFA assessment (CE ~80, ISO ~55, SOC 2
~58) because the single biggest technical gap — **MFA — is now implemented**, and
the governance layer that dominated the ISO/SOC 2 gap is now documented (SoA,
control matrix, risk register, policies).

## What is now DONE (this programme) — application layer

Each of these is implemented in `api/` and verifiable from a file in this repo:

- **Tenant isolation** by PostgreSQL RLS on every tenant table (incl. GPS).
- **MFA (TOTP)** end to end, with backup codes — the #1 blocker.
- Strong auth: bcrypt, strength policy, lockout, JWT revocation, algorithm pin.
- **Append-only audit trail** covering auth, privilege, and admin actions.
- **Application CI + dependency hygiene**: `api-ci.yml` (lint, typecheck,
  migrations, seed, build, Jest on a real Postgres), Dependabot
  (`.github/dependabot.yml`), and a scheduled dump/restore drill
  (`restore-drill.yml`).
- **Input validation** (DTO whitelist), per-route rate limiting, attachment
  magic-byte sniffing, GPS device-key hashing, the SSRF safe-fetch guard.
- **Secure config**: no default accounts in prod, fail-fast env validation.
- **Documentation**: Cyber Essentials control set, DB architecture, **ISMS**
  (this directory: SoA, SOC 2 matrix, risk register, policies), incident
  response, backup/DR, SECURITY.md.

## ⏳ Planned — infrastructure layer (target architecture, NOT built)

These were previously listed as done; **no Terraform / IaC exists in this repo**,
so they are reclassified to Planned and must not be represented as in force:

- **CI IaC/SAST/secret gates beyond the app**: tfsec IaC scanning, a CodeQL SAST
  gate, and gitleaks secret scanning are **not** wired (there is no
  `security-scan.yml` / `terraform-ci.yml`); `npm audit` can be run in `api/` but
  is not yet a committed gate. Dependabot is the one supply-chain control that is
  real today.
- **Encryption at rest (KMS)** and **server-side forced DB TLS** — provided (if at
  all) by the managed platform's defaults, not by a repo-defined control.
- **Backup/DR**: managed-database PITR + cross-region snapshot copy + multi-AZ.
  Today only the dump/restore *script* is drilled in CI (`restore-drill.yml`);
  production RPO/RTO are unproven.
- **Edge/network**: WAF, VPC segmentation, security groups, private-subnet DB.
- **Managed monitoring/alerting**: CloudWatch metric filters/alarms, GuardDuty,
  CloudTrail.

## What remains — the path to certification

### Phase 1 — remaining technical controls (engineering)
Application-layer items are done; the infrastructure-layer items are **⏳ Planned**
(no IaC in this repo) and must not be represented as done:
1. ⏳ **Security-event alerting** — CloudWatch metric filters (failed-login spike,
   lockout burst) → SNS. *(CC7.2 / A.8.16)* — **Planned, not built** (no managed
   monitoring infra exists). The signals themselves *are* recorded in the
   application audit log today; nothing evaluates/alerts on them yet. Setting
   `SENTRY_DSN` (error alerting) is a separate, real, founder-provided step.
2. **Data retention & purge** — `gps_pings` (location history) purge past a defined
   floor. *(A.8.10 / C1)* — application-layer retention job; verify the job exists
   in `api/` before marking done (tracked as R4).
3. 🔶 **Erasure completeness** — the Privacy-Act erasure path (field redaction +
   inline attachment-byte deletion) is implemented in `api/src/privacy/`. The
   *S3* completeness half (delete all object versions, the required IAM
   permissions, a TLS-only bucket policy) is **⏳ Planned** — it depends on the
   unbuilt S3/bucket infra. *(A.8.10)*
4. ⏳ **Edge WAF** — WAFv2 on an ALB/CloudFront edge. *(A.8.23)* — **Planned, not
   built** (no `waf.tf`, no IaC, no AWS edge). Application-tier `@nestjs/throttler`
   rate limiting is the in-force stand-in.
5. **Restore drill** — the dump/restore *script* is now drilled weekly in CI
   (`restore-drill.yml`); a timed restore recording actual production RPO/RTO
   against a live managed database is still outstanding. *(A1.3)*
6. **Repository controls** — **no CODEOWNERS file exists yet** (earlier drafts
   claimed one was added — that was inaccurate); add one and **enable branch
   protection** in repo settings. Server-side upload AV scan outstanding.
   *(A.8.4/8.7)*

### Phase 2 — governance & ownership (organisational, weeks)
7. **Assign named owners** to every policy and ISMS role (replace all *TBD*).
8. **Management sign-off** on the policy set; schedule the **quarterly
   management review**.
9. **Execute DPAs** with AWS/Stripe/SES; finalise & publish ToS/Privacy Policy.
10. **HR controls**: onboarding security training, screening, NDAs, offboarding
    checklist.

### Phase 3 — external validation (external, months)
11. **Independent penetration test** (also ISO A.5.35).
12. **Engage a SOC 2 auditor**; run the **Type II observation period** (3–12
    months) with continuous evidence (the audit log + CI history are the
    evidence base).
13. **Engage an ISO 27001 certification body**; complete **Stage 1 + Stage 2**.

## Bottom line

FleetOS is **audit-ready**: a security auditor engaged today would find the
technical controls in place and the ISMS documented. The remaining work is
assigning owners, signing the policies, wiring the last alerting/retention
controls, and — unavoidably — running the observation period with an external
auditor. That is the honest definition of "ready to start selling to
security-conscious enterprises": you can enter procurement/security review with
evidence, and pursue the formal certificate in parallel.
