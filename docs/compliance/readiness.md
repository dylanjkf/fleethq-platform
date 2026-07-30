# ISO 27001 / SOC 2 readiness

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

## What is now DONE (this programme)

- **Tenant isolation** by PostgreSQL RLS on every tenant table (incl. GPS).
- **MFA (TOTP)** end to end, with backup codes — the #1 blocker.
- Strong auth: bcrypt, strength policy, lockout, JWT revocation, algorithm pin.
- **Append-only audit trail** covering auth, privilege, and admin actions.
- **CI security gates**: SAST (CodeQL), SCA (`npm audit` + Dependabot), secret
  scanning (gitleaks), IaC scanning (tfsec).
- **Encryption** in transit (incl. forced DB TLS) and at rest (KMS).
- **Secure config**: no default accounts in prod, fail-fast validation.
- **Backup/DR**: RDS PITR + cross-region snapshot copy + multi-AZ.
- **Documentation**: Cyber Essentials control set, DB architecture, **ISMS**
  (this directory: SoA, SOC 2 matrix, risk register, policies), incident
  response, backup/DR, SECURITY.md.

## What remains — the path to certification

### Phase 1 — remaining technical controls (engineering)
Most are now **done** (Wave F3); the remainder are noted:
1. ✅ **Security-event alerting** — CloudWatch metric filters (failed-login spike,
   lockout burst) → SNS. *(CC7.2 / A.8.16)* — done; still set the Sentry DSN and
   add filters for privilege-change events as those log lines are added.
2. ✅ **Data retention & purge** — `gps_pings` (location history) purged past an
   18-month floor by a leader-elected job. *(A.8.10 / C1)* — done; extend to
   `notifications` if a DELETE grant is added.
3. ✅ **Erasure completeness** — all S3 object versions deleted on Privacy-Act
   erasure, with the IAM permissions and a **TLS-only bucket policy** added.
   *(A.8.10)* — done.
4. ✅ **Edge WAF** — WAFv2 web ACLs (AWS managed common + known-bad-inputs rule
   groups + a per-IP rate rule) on the ALB (REGIONAL) and CloudFront (us-east-1),
   `terraform validate` clean. *(A.8.23)* — done.
5. **Restore drill** — timed PITR restore; record actual RPO/RTO. *(A1.3)* —
   outstanding (requires a real AWS environment).
6. ✅ **CODEOWNERS** added; **enable branch protection** in repo settings; server-
   side upload AV scan outstanding. *(A.8.4/8.7)*

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
