# FleetOS Compliance & ISMS

> **Scope note (built vs. target).** FleetOS's **application-layer** security
> controls (RLS tenant isolation, RBAC, MFA, audit logging, Privacy Act
> export/erasure, input validation, rate limiting, fail-fast config) are
> implemented and inspectable in `api/`. **Infrastructure-layer** controls
> (network segmentation, WAF, KMS encryption-at-rest, managed monitoring,
> multi-AZ / cross-region database) describe a **target architecture** for the
> planned Railway/AWS deployment and are **not yet built — there is no Terraform
> or other IaC in this repository.** Throughout these documents such controls are
> marked **⏳ Planned**. No control here is marked Implemented on the basis of a
> file that does not exist. See [readiness.md](./readiness.md) for the full
> built-vs-planned breakdown.

This directory is the **governance layer** of FleetOS security — the
Information Security Management System (ISMS) artefacts that ISO/IEC 27001 and
SOC 2 auditors require *in addition to* the technical controls documented under
[`docs/security/cyber-essentials/`](../security/cyber-essentials/) and
[`docs/database/`](../database/).

> ## Read this first — what "certified" actually requires
>
> **You cannot become ISO 27001 or SOC 2 certified from a code repository, and
> no one should tell you otherwise.** Certification is awarded by an external
> body after auditing evidence over time:
>
> - **SOC 2 Type II** requires an **independent CPA firm** to observe your
>   controls operating over a defined period (commonly **3–12 months**) and
>   issue an attestation. The observation window and the auditor are external and
>   time-bound — no amount of code makes them instant.
> - **ISO/IEC 27001** requires an **accredited certification body** to run a
>   Stage 1 (documentation) and Stage 2 (implementation) audit of your ISMS.
>
> What this repository can achieve — and now largely has — is **audit-readiness**:
> every technical control, policy, and record an auditor asks for is in place, so
> the only remaining work is engaging the auditor and running the observation
> period. Where a control is organisational (a signed policy owner, an HR
> process, a real observation period) rather than code, this documentation says
> so plainly. **Do not represent FleetOS as "ISO 27001 certified" or "SOC 2
> compliant" to a customer until an external auditor has issued the report** —
> doing so would be a false claim.

## Documents

| Document | Purpose | Framework anchor |
|----------|---------|------------------|
| [readiness.md](./readiness.md) | Current scores, what's done, and the exact path to certification | Overall |
| [statement-of-applicability.md](./statement-of-applicability.md) | Every ISO/IEC 27001:2022 Annex A control: applicability, status, evidence | ISO 27001 |
| [soc2-control-matrix.md](./soc2-control-matrix.md) | Trust Services Criteria mapped to implemented controls + evidence | SOC 2 |
| [risk-register.md](./risk-register.md) | Identified risks, likelihood/impact, treatment, owner | ISO 27001 Clause 6 |
| [security-policies.md](./security-policies.md) | The core policy set (InfoSec, access control, cryptography, data, secure dev, HR, vendor, BCP) | ISO 27001 / SOC 2 CC1–CC5 |
| [governance-execution.md](./governance-execution.md) | **Phase 2** fill-in records: ownership, policy sign-off, management review, DPA & HR checklists | ISO 27001 Clauses 5–7 |
| [audit-engagement.md](./audit-engagement.md) | **Phase 3** evidence register + pen-test scope + SOC 2 / ISO engagement runbooks | External audit |

Operational procedures live with the technical controls:
[incident response](../security/cyber-essentials/incident-response.md),
[backup & DR](../security/cyber-essentials/backup-and-disaster-recovery.md),
[vulnerability disclosure](../../SECURITY.md).

## How the ISMS is structured

- **Policies** (this directory) state *what* FleetOS commits to.
- **Technical controls** ([`docs/security`](../security/cyber-essentials/),
  [`docs/database`](../database/)) are *how* those commitments are enforced in
  code and infrastructure, with source-level evidence.
- **Records** — the append-only `audit_logs` table, CI run history, the risk
  register, and (once the observation period begins) change and access records —
  are the *evidence* that the controls operated.

## Ownership placeholders

These documents reference roles (ISMS Owner, Security Officer, Privacy Officer,
Incident Lead). Before an audit, assign each to a **named individual** — the
frameworks require accountable owners, not just a function. Placeholders are
marked *TBD* throughout.
