# Risk register

The ISMS risk register (ISO 27001 Clause 6.1 / SOC 2 CC3). Each risk is scored
**Likelihood × Impact** (Low/Med/High) to a residual rating **after** existing
controls, with a treatment decision and owner. Review at least quarterly and on
any significant change.

**Treatment:** Mitigate · Accept · Transfer · Avoid.

| ID | Risk | Existing controls | Likelihood | Impact | Residual | Treatment | Action / owner |
|----|------|-------------------|:----------:|:------:|:--------:|-----------|----------------|
| R1 | Cross-tenant data exposure | PostgreSQL RLS (forced) on all tenant tables incl. GPS; tenant-isolation e2e; least-privilege roles | Low | High | **Low** | Mitigate | Maintain RLS coverage test on every new table · *Eng* |
| R2 | Credential compromise / account takeover | MFA (TOTP), bcrypt, brute-force lockout, JWT revocation, algorithm pinning | Low | High | **Low** | Mitigate | Enforce MFA for admin roles (policy) · *Security Officer TBD* |
| R3 | No alerting on security signals — an attack in progress goes unnoticed | Append-only audit log records the signals; no managed monitoring/alerting exists yet (⏳ planned) | Med | High | **Med** | Mitigate | Build managed monitoring (metric filters on audit/failed-login → alerts); set `SENTRY_DSN` · *Eng* |
| R4 | Unbounded growth of append-only tables (`gps_pings`, `timeline_events`, `audit_logs`) — cost + location-privacy | Read paths indexed; RLS | Med | Med | **Med** | Mitigate | Define retention floors + scheduled purge/archive job · *Eng* |
| R5 | Incomplete erasure — S3 object versioning retains an "erased" attachment version | Privacy-Act field redaction + current-object delete | Med | Med | **Med** | Mitigate | Delete all object versions on erasure; TLS-only bucket policy · *Eng* |
| R6 | Disaster recovery not proven at scale | CI dump/restore drill (`restore-drill.yml`); managed-DB PITR + cross-region + multi-AZ are ⏳ planned (no IaC) | Med | High | **Med** | Mitigate | Build the managed-DB backup topology; run a timed live-DB restore; record actual RPO/RTO · *Eng/Ops TBD* |
| R7 | No edge WAF | @nestjs/throttler app-tier rate limiting only; WAFv2 on an ALB/CloudFront edge is ⏳ **planned, not built** (no IaC, no `waf.tf`) | Med | Med | **Med** | Mitigate | Stand up an edge + WAF (managed common + known-bad-inputs + per-IP rate rule), or accept the managed-platform edge explicitly · *Eng* |
| R8 | Supply-chain vulnerability in dependencies | Dependabot (npm + Actions) in force; `npm audit` runnable. A committed audit gate, CodeQL, gitleaks, and tfsec are ⏳ planned (no `security-scan.yml`) | Med | Med | **Med** | Mitigate | Wire the SCA/SAST/secret-scan CI gate; add remediation-SLA policy · *Eng* |
| R9 | Insider misuse / excessive privilege | RBAC least privilege; audit trail; last-admin guard | Low | Med | **Low** | Mitigate | Formal SoD matrix + periodic access recertification · *Security Officer TBD* |
| R10 | Malicious file upload | Type allowlist + magic-byte sniff + size caps; no execution | Low | Med | **Low** | Mitigate | Add server-side AV scan; serve PDFs as attachments · *Eng* |
| R11 | Governance gaps block certification (no signed policies, owners, review) | Draft ISMS doc set (this directory) | High | Med | **Med** | Mitigate | Assign named owners; sign policies; schedule management review · *Founder/ISMS Owner TBD* |
| R12 | Endpoint compromise of a staff device with production access | Bearer-token MFA sessions; least privilege | Med | Med | **Med** | Mitigate | Endpoint policy (disk encryption, screen lock); consider MDM · *HR/Ops TBD* |
| R13 | Sub-processor (AWS/Stripe/SES) incident or non-compliance | Reputable certified sub-processors | Low | Med | **Low** | Transfer/Accept | Execute DPAs; annual sub-processor review · *Legal TBD* |
| R14 | Lost source-code integrity / unauthorised change to production | Private repo; CI gates; manual-approval deploy | Low | High | **Low** | Mitigate | Enable branch protection + required review + CODEOWNERS · *Eng* |
| R15 | Regulatory non-compliance (Australian Privacy Act / NDB) | Export/erasure path; NDB procedure in incident-response; ToS/Privacy/DPA drafts | Low | High | **Low** | Mitigate | Finalise + publish legal docs; appoint Privacy Officer · *Legal/Founder TBD* |

## Reading this register

The genuinely open, actionable **technical** risks (R3, R4, R5, R6, R7, R10) are
sequenced in [readiness.md](./readiness.md) Phase 1/3. The **Med** residual risks
concentrated in **R11/R12/R13** are governance/organisational — they close with
named owners, signed policies, and executed agreements, not code. No **High**
residual risk remains after existing controls.
