# FleetOS security readiness assessment

*Assessed against the technical control set in this directory, as of the E1–E3
security hardening waves. This is a rigorous engineering self-assessment, not a
certification or an independent audit — see the caveats in each section.*

## Executive summary

FleetOS has a **strong technical control base**: database-enforced multi-tenant
isolation (PostgreSQL row-level security), least-privilege database roles,
granular RBAC, an append-only security audit trail, encryption in transit and at
rest, fail-fast secure configuration, and dependency/secret/SAST scanning wired
into CI. The recent hardening waves closed the most serious findings a 12-domain
audit surfaced — most importantly a **production default-account vulnerability**
(the deploy seed provisioned demo tenants with a known password) and the fact
that **privilege-change events were declared but never actually logged**.

The gap now is **governance and a small number of high-value technical
controls**, not the control foundation. The single most important remaining item
is **multi-factor authentication for privileged accounts** — it is the one
Cyber Essentials requirement that is not yet met and the highest-leverage
enterprise-trust item. Formal ISMS artefacts (risk register, policies, a SOC 2
observation period) are the main distance to certification.

## Headline scores

| Framework | Readiness | One-line basis |
|-----------|:---------:|----------------|
| **Cyber Essentials** (self-assessment) | **80 / 100** | Four of five control themes substantially met; MFA for admin accounts is the binding gap, edge WAF the other. |
| **ISO/IEC 27001:2022** alignment | **55 / 100** | Annex A *technical* controls are strong (~70%); the *management system* (Clauses 4–10: risk assessment, SoA, policies, internal audit, management review) is largely absent (~30%). |
| **SOC 2 (2017 TSC)** alignment | **58 / 100** | Strong on CC6 (logical access) and improving CC7 (monitoring); weak on formal policies, control monitoring/alerting, and there is no observation period or independent examination yet. |

Scores are directional, weighted across the domains below. They express *how far
along* the technical and organisational work is, not a pass/fail against a
certifier's checklist.

## Domain scorecard

Each domain links to its evidence-based control document.

| # | Domain | Maturity | Score | Notes |
|---|--------|----------|:-----:|-------|
| 1 | [Secure network architecture](./01-secure-network-architecture.md) | Strong | 85 | TLS everywhere, private DB, segmented VPC, HSTS preload; **no WAF**, DB TLS now forced. |
| 2 | [Secure configuration](./02-secure-configuration.md) | Strong | 82 | Fail-fast env validation, no verbose prod errors, **default-account risk fixed**; NODE_ENV string-gating is brittle in places. |
| 3 | [Access control & user management](./03-access-control.md) | Strong | 82 | RLS + RBAC + least-privilege DB roles + last-admin lockout guard; no MFA, no SoD limit. |
| 4 | [Patch & vulnerability management](./04-patch-and-vulnerability-management.md) | Strong | 80 | CI `npm audit` gate + Dependabot + CodeQL; ECR scan doesn't gate deploy, base images on floating tags. |
| 5 | [Malware & file-upload protection](./05-malware-and-file-upload-protection.md) | Moderate | 68 | Allowlist + magic-byte sniff + size caps; **no AV scan** of uploads, PDFs served inline. |
| 6 | [Secure development lifecycle](./06-secure-development-lifecycle.md) | Strong | 78 | SAST + secret scan + dependency review + IaC scan in CI; branch protection not evidenced from repo. |
| 7 | [Authentication & password security](./07-authentication-and-password-security.md) | Moderate | 70 | bcrypt, strength policy, lockout, JWT revocation, algorithm pinned; **no MFA**, no self-service password change. |
| 8 | [Device & session management](./08-device-and-session-management.md) | Moderate | 60 | Coarse token-version revocation; no per-session logout, no MFA, no SSO/MDM readiness, 12h token. |
| 9 | [Security monitoring & audit logging](./09-security-monitoring-and-audit-logging.md) | Moderate | 70 | Append-only audit log now covers auth + **privilege/admin actions**; **no alerting** on security signals yet. |
| 10 | [Secure data handling](./10-secure-data-handling.md) | Moderate | 72 | Encryption at rest/in transit, RLS, Privacy-Act export/erase; S3 versioning can retain "erased" objects, no GPS retention. |
| 11 | [Security testing](./11-security-testing.md) | Strong | 78 | Large e2e suite incl. tenant-isolation + audit tests, SAST, dependency audit; no DAST, no independent pentest. |
| 12 | Security operations documentation *(this suite)* | Strong | 80 | This control set + [incident response](./incident-response.md) + [backup/DR](./backup-and-disaster-recovery.md) + [SECURITY.md](../../../SECURITY.md); no signed ISMS policy set. |

## Cyber Essentials — control-theme readiness

Cyber Essentials v3.1 defines five technical control themes. FleetOS status:

1. **Firewalls / boundary** — *Met, with a gap.* AWS security groups chain
   ALB→API→DB; the database is not publicly accessible; only 443/80 ingress from
   the internet. **Gap:** no AWS WAF at the edge (app-level throttling only).
2. **Secure configuration** — *Met.* No default accounts in production (fixed),
   fail-fast env validation, secure headers, no verbose error leakage, request
   size limits.
3. **Security update management** — *Met.* Dependabot across all apps + Actions,
   a CI `npm audit` gate on production dependencies, CodeQL, and a weekly scan.
4. **User access control** — *Partially met.* Unique per-user accounts, RBAC,
   least privilege, and account lifecycle are all present. **Gap (binding):**
   Cyber Essentials v3.1 requires **MFA on cloud service administrator
   accounts**; FleetOS has no MFA yet. *This is the one item that would fail a
   Cyber Essentials self-assessment today.*
5. **Malware protection** — *Substantially met for a SaaS.* The application does
   not execute uploaded content, validates type by magic bytes, and caps size;
   endpoint AV is the customer's responsibility for their own devices. **Gap:**
   no server-side AV scan of stored files.

**Bottom line:** Cyber Essentials certification is achievable within a single
focused sprint. The critical path is **MFA for admin accounts**; an edge WAF and
a server-side AV scan are the next two items.

## ISO/IEC 27001:2022 alignment

FleetOS maps well to **Annex A technical controls** — A.5.15/5.18 (access
control), A.8.2/8.3 (privileged & restricted access), A.8.5 (secure
authentication), A.8.8 (technical vulnerabilities), A.8.9 (configuration),
A.8.13 (backup), A.8.15/8.16 (logging & monitoring), A.8.24 (cryptography),
A.8.25–8.29 (secure development & testing). Each is documented with source
evidence in this suite.

The distance to certification is the **Information Security Management System**
itself (Clauses 4–10): there is no documented ISMS scope, no risk assessment and
risk-treatment plan, no Statement of Applicability, no security policy set with
management sign-off, no internal audit programme, and no management-review
cadence. These are organisational, not code — the strong control base is a good
foundation to wrap an ISMS around, but the ISMS is the bulk of the remaining
27001 work.

## SOC 2 (2017 Trust Services Criteria) alignment

- **CC6 Logical & physical access** — *Strong.* RLS multi-tenancy, RBAC, least
  privilege, credential handling (bcrypt, secrets from AWS Secrets Manager),
  encryption. This is FleetOS's strongest criterion.
- **CC7 System operations** — *Improving.* An append-only audit trail now
  records authentications, privilege changes, and admin actions; CI vulnerability
  scanning is in place. **Gap:** no alerting on security signals — the audit log
  is written but nothing watches it, and infrastructure alarms cover health only.
- **CC8 Change management** — *Adequate.* Versioned migrations, IaC under
  review, CI gates, manual-approval production deploys.
- **CC1–CC5 (control environment, risk assessment, monitoring of controls)** —
  *Weak.* These are governance functions (policies, risk register, control
  self-assessment) that are largely undocumented.
- **Type II specifically** requires an **observation period** (typically 3–12
  months) with evidence that controls operated effectively throughout. That
  period has not begun, so Type II readiness is lower than the design-level
  score above.

## Remaining weaknesses (prioritised)

### High
1. **No multi-factor authentication.** Single-factor password auth for all
   accounts, including admins. Blocks Cyber Essentials; weakens SOC 2 CC6.1.
   *Highest-priority item.* (See [07](./07-authentication-and-password-security.md), [08](./08-device-and-session-management.md).)
2. **No alerting on security signals.** The audit log and failed-login records
   exist but nothing evaluates them; there is no alert on failed-login spikes,
   privilege changes, or audit-write failures, and Sentry is inert until a DSN is
   set. (See [09](./09-security-monitoring-and-audit-logging.md).)
3. **No edge WAF.** The only request-abuse control on public entry points is
   application-level throttling. (See [01](./01-secure-network-architecture.md).)
4. **Erasure completeness & retention.** S3 object versioning can retain a prior
   version of an "erased" attachment, and GPS breadcrumb history has no retention
   or purge. (See [10](./10-secure-data-handling.md).)

### Medium
5. No independent penetration test and no DAST — all automated testing is
   white-box.
6. Branch protection / mandatory code review is not evidenced or enforced from
   the repository.
7. No formal ISMS artefacts (risk register, Statement of Applicability, signed
   policy set) — the gating factor for ISO 27001 / SOC 2.
8. No authenticated self-service password change; no per-session logout or
   session listing; coarse (all-sessions) revocation; 12h tokens without refresh
   rotation.
9. No SSO / OIDC / SCIM readiness for enterprise identity.
10. No formal data classification scheme.

### Low
11. PDFs served `Content-Disposition: inline`; no server-side AV scan; no
    per-tenant storage quota.
12. Reset-token issuance is IP-throttled but not per-account.
13. Container base images and third-party Actions pinned to floating tags
    (patched on rebuild, not digest-pinned).
14. No VPC flow logs or ALB access logs for network-level forensics.

## Remediation roadmap

### Phase 1 — certification blockers (target: 1 sprint)
- **MFA (TOTP)** for admin/privileged accounts, with enrolment enforcement and
  recovery codes; schema + auth-flow changes.
- **Security-event alerting:** CloudWatch metric filters on `audit_logs` and the
  application logs (failed-login rate, `account_locked`, `role_permissions_changed`,
  audit-write-failure), wired to an SNS alarm; set the Sentry DSN.
- **Edge WAF:** an `aws_wafv2_web_acl` (managed common + known-bad-inputs rule
  groups + a rate-based rule) associated to the ALB and CloudFront.
- **Repository controls:** enable branch protection + required review + required
  status checks; add a CODEOWNERS file; enforce a coverage threshold in CI.

### Phase 2 — governance for ISO 27001 / SOC 2 (target: 1 quarter)
- ISMS scope, Statement of Applicability, and a risk register with a
  risk-treatment plan.
- A signed security policy set (access control, cryptography, acceptable use,
  incident response, backup/BCP).
- Begin the SOC 2 observation period with continuous evidence collection.
- Commission an **independent penetration test** (recommended before/just after
  the first enterprise customer's data lands).

### Phase 3 — depth (target: ongoing)
- SSO/OIDC + SCIM; per-session logout, session listing, and refresh-token
  rotation; step-up auth for sensitive actions.
- Erasure completeness (delete versioned S3 objects on Privacy-Act erasure) and a
  GPS breadcrumb retention/purge job.
- DAST in CI; VPC flow logs + ALB access logs; container image digest pinning;
  server-side AV scan of uploads.

## How this was assessed

The control inventory in this directory was written from a file-level audit of
the codebase and infrastructure; the scores weight each domain's implemented
controls against its open gaps, and the framework scores aggregate the domains
with extra weight on governance for ISO 27001 / SOC 2 (where FleetOS is weakest)
and on technical controls for Cyber Essentials (where it is strongest). No
external party has validated these numbers — an independent penetration test and
a formal gap assessment against each framework are the natural next steps and are
in the roadmap above.
